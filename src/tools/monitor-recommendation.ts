/**
 * Agent tool: deterministically generate ALL due post-application impact
 * reports.
 *
 * DETERMINISTIC TOOL LOGIC with NO model-chosen inputs: the tool takes NO
 * recommendation id and NO checkpoint from the model (input schema is empty).
 * It reads every applied recommendation and the already-recorded checkpoints
 * from trusted persistent state, uses the latest completed `endDay` (the
 * monitoring signal's endDay, or the current completed day as a fallback), and
 * processes the DUE (recommendationId, checkpoint) pairs in the fixed schedule
 * order (24h before 7d), each exactly once.
 *
 * For each due pair it:
 *   1. Builds the deterministic impact report from the R2 rollups (pre = N full
 *      days before appliedDay; post = N full days after appliedDay; never
 *      overlapping, never backfilled with pre dates).
 *   2. Persists the outcome idempotently to a deterministic R2 key.
 *   3. Records a concise outcome in persistent state.
 *   4. Sends the rendered report through the existing {@link ReportSender}.
 *
 * The tool is DURABLE with per-recommendation-per-checkpoint step names
 * (`build-<rec>-<cp>`, `persist-<rec>-<cp>`, `send-<rec>-<cp>`), so a retried
 * or replayed execution converges. The R2 write overwrites, the state record
 * dedupes, and a due checkpoint is never recomputed once recorded.
 *
 * This tool generates and sends monitoring REPORTS only. It does NOT roll back
 * — rollback is an application-owned service, not a model tool.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import type { R2Store } from "../analytics/storage.ts";
import {
  buildMonitoringReport,
  dueCheckpoints,
  outcomeId,
  renderMonitoringHtml,
  renderMonitoringText,
  type MonitoringCheckpoint,
} from "../analytics/monitor.ts";
import { writeOutcome } from "../analytics/outcome-storage.ts";
import { recordCheckpointOutcome } from "../shared/monitor-state.ts";
import type { ReportSender } from "../shared/send.ts";
import type { MonitoringRecord } from "../shared/types.ts";
import { yesterdayIso } from "../shared/dates.ts";
import type { ZoneStateSetter } from "./issue-recommendation.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

/** An applied rule the monitor tool may have a due checkpoint for. */
export interface AppliedRuleForMonitor {
  recommendationId: string;
  appliedAt: string;
  cloudflareRuleId?: string;
}

export interface MonitorRecommendationDeps {
  zoneId: string;
  hostname: string;
  resolveBucket: () => R2Store;
  /** Live getter over the applied rules in trusted state. */
  resolveAppliedRules: () => AppliedRuleForMonitor[];
  /** Live getter over the already-recorded checkpoints in trusted state. */
  resolveMonitoringRecords: () => MonitoringRecord[];
  /** Latest completed day: the monitoring signal's endDay, else current completed day. */
  resolveEndDay: () => string;
  setState: ZoneStateSetter;
  /** Fail-closed ReportSender (tests inject a fake; may be absent). */
  sender?: ReportSender;
  /** Inject a clock for deterministic tests. */
  now?: Date;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<
    ZoneContext,
    "resolveZoneConfig" | "resolveSlice" | "setSlice" | "resolveBucket"
  >;
}

/** Empty input: the model cannot choose a recommendation or checkpoint. */
const inputSchema = v.object({
  /** The zone whose applied rules to monitor (validated against D1). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  endDay: v.string(),
  processed: v.array(
    v.object({
      recommendationId: v.string(),
      checkpoint: v.string(),
      reportId: v.string(),
      outcomeKey: v.string(),
      preRequests: v.number(),
      postRequests: v.number(),
      requestVolumeReduction: v.optional(v.number()),
      fullCoverage: v.boolean(),
      sent: v.boolean(),
      transport: v.string(),
      detail: v.string(),
    }),
  ),
  skippedNotDue: v.array(v.string()),
});

/** Build an email subject for a monitoring report. */
function monitoringSubject(hostname: string, checkpoint: MonitoringCheckpoint): string {
  return `Bot Traffic Impact Report (${checkpoint}) — ${hostname}`;
}

/** Factory for the deterministic, all-due monitoring tool. */
export function createMonitorRecommendationTool(deps: MonitorRecommendationDeps) {
  return defineTool({
    name: "monitor_recommendation",
    description:
      "Deterministically compute and send ALL due post-application impact reports (24h and 7d) for every applied recommendation whose full post window is complete, using the latest completed day. No recommendation or checkpoint input is taken; all impact math and due-check logic run in code. Outcomes are persisted to R2 and reports are sent through the report sender. This tool NEVER performs rollback.",
    input: inputSchema,
    output: outputSchema,
    durable: true,
    run: async ({ data, step }) => {
      const clock = deps.now ?? new Date();
      // Resolve the target zone (model-supplied zoneId validated against
      // D1, else the mounted default) and its slice. All applied rules,
      // monitoring records, endDay, and writes are scoped to that zone's slice;
      // R2 remains zone-keyed. The model cannot choose a recommendation or
      // checkpoint — the tool processes all DUE pairs from trusted state.
      let targetZoneId = deps.zoneId;
      let targetHostname = deps.hostname;
      let appliedRules = deps.resolveAppliedRules();
      let records = deps.resolveMonitoringRecords();
      let endDay = deps.resolveEndDay() || yesterdayIso();
      let bucket = deps.resolveBucket();
      let setSlice: ZoneStateSetter = deps.setState;
      if (deps.zoneContext) {
        const target = await resolveTargetZone(deps.zoneContext, data.zoneId, deps.zoneId);
        targetZoneId = target.zoneId;
        targetHostname = target.config?.hostname ?? deps.hostname;
        const slice = deps.zoneContext.resolveSlice(targetZoneId);
        appliedRules = slice.appliedRules.map((a) => ({
          recommendationId: a.recommendationId,
          appliedAt: a.appliedAt,
          cloudflareRuleId: a.cloudflareRuleId,
        }));
        records = slice.monitoringRecords ?? [];
        endDay = slice.lastMonitoringEndDay ?? endDay;
        bucket = deps.zoneContext.resolveBucket(targetZoneId);
        setSlice = (value) => deps.zoneContext!.setSlice(targetZoneId, value);
      }
      const endDayFinal = endDay || yesterdayIso();

      const processed: {
        recommendationId: string;
        checkpoint: string;
        reportId: string;
        outcomeKey: string;
        preRequests: number;
        postRequests: number;
        requestVolumeReduction?: number;
        fullCoverage: boolean;
        sent: boolean;
        transport: string;
        detail: string;
      }[] = [];
      const skippedNotDue: string[] = [];

      // Process 24h then 7d exactly once each, per recommendation.
      for (const applied of appliedRules) {
        const recRecords = records.filter((r) => r.recommendationId === applied.recommendationId);
        const due = dueCheckpoints(applied.appliedAt, endDayFinal, recRecords);

        for (const checkpoint of due) {
          const key = `${applied.recommendationId}-${checkpoint}`;
          const report = await step.do(`build-${key}`, () =>
            buildMonitoringReport({
              bucket,
              zoneId: targetZoneId,
              hostname: targetHostname,
              recommendationId: applied.recommendationId,
              cloudflareRuleId: applied.cloudflareRuleId,
              appliedAt: applied.appliedAt,
              checkpoint,
              endDay: endDayFinal,
            }),
          );
          // buildMonitoringReport returns null when not due; dueCheckpoints
          // already guards this, but keep the null guard for safety.
          if (!report) {
            skippedNotDue.push(key);
            continue;
          }

          const outcomeKey = await step.do(`persist-${key}`, () =>
            writeOutcome(bucket, report, clock.toISOString()),
          );

          setSlice((prev) => {
            const transition = recordCheckpointOutcome(prev, {
              recommendationId: applied.recommendationId,
              checkpoint,
              outcomeKey,
              endDay: report.endDay,
              generatedAt: clock.toISOString(),
              fullCoverage: report.fullCoverage,
            });
            return transition.next ?? prev;
          });

          const reportId = outcomeId(targetZoneId, applied.recommendationId, checkpoint);
          let sendDetail = "no sender configured";
          let transport = "none";
          let sent = false;
          if (deps.sender) {
            const result = await step.do(`send-${key}`, () =>
              deps.sender!.send({
                zoneId: targetZoneId,
                reportId,
                subject: monitoringSubject(targetHostname, checkpoint),
                html: renderMonitoringHtml(report),
                text: renderMonitoringText(report),
              }),
            );
            sent = result.sent;
            transport = result.transport;
            sendDetail = result.detail;
          }

          const reductionMetric = report.metrics.find((m) => m.metric === "request_volume_reduction");
          processed.push({
            recommendationId: applied.recommendationId,
            checkpoint,
            reportId,
            outcomeKey,
            preRequests: report.pre.requestCount,
            postRequests: report.post.requestCount,
            requestVolumeReduction:
              reductionMetric?.available && reductionMetric.value !== undefined
                ? reductionMetric.value
                : undefined,
            fullCoverage: report.fullCoverage,
            sent,
            transport,
            detail: sendDetail,
          });
        }
      }

      return { output: { endDay: endDayFinal, processed, skippedNotDue } };
    },
  });
}