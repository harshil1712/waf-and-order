/**
 * Agent tool: generate the weekly report.
 *
 * Reads the seven-day history from R2, builds the capability-scoped report,
 * and renders HTML and plain-text versions. Every traffic string is escaped
 * and truncated during rendering. This tool does not send anything; delivery
 * is the send tool's responsibility.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { SEVEN_DAY_WINDOW, readHistory } from "../analytics/reader.ts";
import {
  buildWeeklyReport,
  renderReportHtml,
  renderReportText,
} from "../analytics/report.ts";
import type { R2Store } from "../analytics/storage.ts";
import { yesterdayIso } from "../shared/dates.ts";
import { addDays } from "../analytics/backfill.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

export interface GenerateReportToolDeps {
  zoneId: string;
  hostname: string;
  resolveBucket: () => R2Store;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<ZoneContext, "resolveZoneConfig" | "resolveBucket">;
}

const inputSchema = v.object({
  endDay: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
  /** The zone to report on (validated against D1). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  reportId: v.string(),
  zoneId: v.string(),
  hostname: v.string(),
  startDay: v.string(),
  endDay: v.string(),
  generatedAt: v.string(),
  daysPresent: v.number(),
  daysExpected: v.number(),
  missingDays: v.array(v.string()),
  totalRequests: v.number(),
  totalBytes: v.number(),
  html: v.string(),
  text: v.string(),
});

/** Factory for the generate-report tool. */
export function createGenerateReportTool({ zoneId, hostname, resolveBucket, zoneContext }: GenerateReportToolDeps) {
  return defineTool({
    name: "generate_weekly_report",
    description:
      "Read the last seven days of rollups and render the weekly bot-traffic report as HTML and plain text. Returns the rendered report plus its structured metrics. Call send_weekly_report to deliver it. Optionally pass zoneId; the hostname is always resolved from trusted config, never supplied by you.",
    input: inputSchema,
    output: outputSchema,
    run: async ({ data }) => {
      // Resolve the target zone (model-supplied zoneId validated against
      // D1, else the mounted default). The hostname always comes from D1 config,
      // never from the model.
      const target = zoneContext
        ? await resolveTargetZone(zoneContext, data.zoneId, zoneId)
        : { zoneId };
      const targetZoneId = target.zoneId;
      const targetHostname = target.config?.hostname ?? hostname;
      const bucket = zoneContext
        ? zoneContext.resolveBucket(targetZoneId)
        : resolveBucket();
      // The weekly report ends on the previous COMPLETED UTC day (today's
      // rollup does not exist yet).
      const endDay = data.endDay ?? yesterdayIso();
      const startDay = addDays(endDay, -(SEVEN_DAY_WINDOW - 1));
      const { rollups, missingDays } = await readHistory(bucket, targetZoneId, endDay, SEVEN_DAY_WINDOW);

      const report = buildWeeklyReport(rollups, {
        zoneId: targetZoneId,
        hostname: targetHostname,
        startDay,
        endDay,
        generatedAt: new Date().toISOString(),
      });

      return {
        output: {
          reportId: report.reportId,
          zoneId: report.zoneId,
          hostname: report.hostname,
          startDay: report.startDay,
          endDay: report.endDay,
          generatedAt: report.generatedAt,
          daysPresent: report.daysPresent,
          daysExpected: report.daysExpected,
          missingDays: report.missingDays,
          totalRequests: report.totalRequests,
          totalBytes: report.totalBytes,
          html: renderReportHtml(report),
          text: renderReportText(report),
        },
      };
    },
  });
}