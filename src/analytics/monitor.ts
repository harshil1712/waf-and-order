/**
 * Deterministic post-application impact monitoring.
 *
 * Computes 24-hour and 7-day impact reports by comparing pre-application and
 * post-application windows using ONLY the daily rollups that already exist in
 * R2. It deliberately uses a single non-overlapping grouping set —
 * `verified_bot_country` — for all totals, so pre/post numbers never double
 * count overlapping rollups.
 *
 * Metric availability is explicit and conservative. Only these metrics are
 * genuinely supported by the collected rollups on this plan:
 *
 *   - request_count            (request totals per window)
 *   - bytes                    (edge response bytes per window)
 *   - request_volume_reduction (delta / ratio between post and pre totals)
 *
 * The following are explicitly reported as UNAVAILABLE because the source data
 * (plain R2 daily rollups with no security events, no referral, no origin-error
 * dataset) cannot support them — they are never fabricated:
 *
 *   - rule_match_count          (needs security-event match counts)
 *   - challenge_count           (needs firewall events)
 *   - challenge_solve_rate      (needs firewall events)
 *   - search_referral_changes   (needs referral dimensions, not collected)
 *   - origin_error_rate         (needs origin-status dataset, not collected)
 *   - estimated_cost_reduction  (needs plan/billing data, not collected)
 *   - likely_legitimate_traffic_exposure (heuristic; the rollups carry no
 *       human-like signal such as challenge-solve behavior, so it cannot be
 *       derived here and is reported unavailable rather than guessed)
 *
 * Coverage is always surfaced: each window reports how many days were present,
 * how many were expected, which days are missing, and which grouping sets were
 * truncated at collection time. Missing days are never fabricated.
 *
 * This module is pure and unit-testable; persistence and delivery are separate.
 */

import { addDays } from "./backfill.ts";
import { readRollupForDay, type R2Store } from "./storage.ts";
import type { DailyRollup, GroupingSetName } from "./types.ts";

/** The single non-overlapping grouping set used for all monitoring totals. */
const MONITOR_GROUPING_SET: GroupingSetName = "verified_bot_country";

/** Available monitoring checkpoints. */
export type MonitoringCheckpoint = "24h" | "7d";

/** The monitoring checkpoints the MVP schedules. */
const MONITOR_CHECKPOINTS: MonitoringCheckpoint[] = ["24h", "7d"];

/** The post/pre window length in days for each checkpoint (24h → 1, 7d → 7). */
export function checkpointDays(checkpoint: MonitoringCheckpoint): number {
  return checkpoint === "24h" ? 1 : 7;
}

/** A named monitoring metric, either supported (a value) or explicitly unavailable. */
export interface MonitoringMetric {
  metric: string;
  available: boolean;
  /** Present when `available` is true. */
  value?: number;
  /** Present when `available` is true and the metric is a reduction/ratio. */
  percentChange?: number;
  /** Explanation of why the metric is supported or unavailable. */
  reason: string;
}

/** Aggregate totals for one window, from the single monitor grouping set. */
export interface WindowTotals {
  daysPresent: number;
  daysExpected: number;
  missingDays: string[];
  truncatedGroupingSets: GroupingSetName[];
  requestCount: number;
  bytes: number;
}

/** The structured post-application impact report for one checkpoint. */
export interface MonitoringReport {
  zoneId: string;
  hostname: string;
  recommendationId: string;
  cloudflareRuleId?: string;
  appliedAt: string;
  checkpoint: MonitoringCheckpoint;
  /** The latest completed day (endDay) this report was computed from. */
  endDay: string;
  /** The exact non-overlapping pre-window days (N full days before appliedDay). */
  preDays: string[];
  /** The exact non-overlapping post-window days (N full days after appliedDay). */
  postDays: string[];
  pre: WindowTotals;
  post: WindowTotals;
  /** Supported + explicitly-unavailable metrics. Never fabricated. */
  metrics: MonitoringMetric[];
  /** Whether both windows have full coverage (used to gate rollback advice). */
  fullCoverage: boolean;
}

/** An explicit, capability-backed reason for every unavailable metric. */
const UNAVAILABLE_METRICS: { metric: string; reason: string }[] = [
  {
    metric: "rule_match_count",
    reason:
      "unavailable: the R2 rollups carry no security-event match counts (firewallEventsAdaptiveGroups is not available to this zone).",
  },
  {
    metric: "challenge_count",
    reason: "unavailable: no firewall-event dataset is collected for this zone.",
  },
  {
    metric: "challenge_solve_rate",
    reason:
      "unavailable: challenge solves require firewall events, which are not collected for this zone.",
  },
  {
    metric: "search_referral_changes",
    reason:
      "unavailable: referral dimensions are not part of the collected rollups on this plan.",
  },
  {
    metric: "origin_error_rate",
    reason:
      "unavailable: the rollups do not carry an origin-status dataset; edge status groups cannot be interpreted as origin errors.",
  },
  {
    metric: "estimated_cost_reduction",
    reason:
      "unavailable: the MVP has no plan/billing cost data and never estimates spend impact.",
  },
  {
    metric: "likely_legitimate_traffic_exposure",
    reason:
      "unavailable heuristic: the rollups carry no human-like signal (e.g. challenge-solve behavior) to derive it, so it is not reported rather than guessed.",
  },
];

/** The `path_status` grouping carries edge status; it is not surfaced as origin errors (see UNAVAILABLE_METRICS). */

/**
 * The inclusive pre-window days for a checkpoint: the `count` FULL days ending
 * at `appliedDay - 1`. Because application can happen mid-day, the applied day
 * itself is never counted as either pre or post traffic; the full-day windows
 * are strictly before and strictly after it, so they never overlap.
 * Oldest first.
 */
export function preWindowDays(appliedDay: string, count: number): string[] {
  const days: string[] = [];
  for (let i = count; i >= 1; i--) {
    days.push(addDays(appliedDay, -i));
  }
  return days;
}

/**
 * The inclusive post-window days for a checkpoint: the `count` FULL days
 * starting at `appliedDay + 1`. Never includes the applied day and never
 * backfills with pre-application dates.
 * Oldest first.
 */
export function postWindowDays(appliedDay: string, count: number): string[] {
  const days: string[] = [];
  for (let i = 1; i <= count; i++) {
    days.push(addDays(appliedDay, i));
  }
  return days;
}

/** The last (most recent) post-window day required for a checkpoint. */
export function postWindowEnd(appliedDay: string, count: number): string {
  return addDays(appliedDay, count);
}

/**
 * Whether a checkpoint is DUE given the latest completed day `endDay`: the full
 * post window must be available, i.e. `endDay >= postWindowEnd(appliedDay, count)`.
 * A checkpoint is never computed early or against a partial post window.
 */
export function isCheckpointDue(appliedDay: string, count: number, endDay: string): boolean {
  return endDay >= postWindowEnd(appliedDay, count);
}

/**
 * Compute the due checkpoints for an applied rule given the latest completed
 * day and the checkpoints already recorded for it. Returns them in the fixed
 * scheduling order (24h before 7d) so each is processed exactly once.
 */
export function dueCheckpoints(
  appliedAt: string,
  endDay: string,
  recorded: readonly { checkpoint: MonitoringCheckpoint }[],
): MonitoringCheckpoint[] {
  const appliedDay = appliedAt.slice(0, 10);
  const already = new Set(recorded.map((r) => r.checkpoint));
  return MONITOR_CHECKPOINTS.filter(
    (cp) => !already.has(cp) && isCheckpointDue(appliedDay, checkpointDays(cp), endDay),
  );
}

/** Sum requestCount across a grouping set's cells for a set of rollups. */
function sumRequests(rollups: DailyRollup[]): number {
  return rollups.reduce(
    (sum, rollup) =>
      sum + (rollup.groupingSets[MONITOR_GROUPING_SET] ?? []).reduce((s, c) => s + c.requestCount, 0),
    0,
  );
}

/** Sum bytes across a grouping set's cells for a set of rollups. */
function sumBytes(rollups: DailyRollup[]): number {
  return rollups.reduce(
    (sum, rollup) =>
      sum + (rollup.groupingSets[MONITOR_GROUPING_SET] ?? []).reduce((s, c) => s + c.bytes, 0),
    0,
  );
}

/**
 * Compute totals for an explicit set of days by reading (and integrity-
 * verifying) each day's rollup. Missing days are tracked, not fabricated, and
 * never backfilled. Returns totals plus the verified rollups for reuse.
 */
export async function computeWindowTotals(
  bucket: R2Store,
  zoneId: string,
  days: string[],
): Promise<{ totals: WindowTotals; rollups: DailyRollup[] }> {
  const rollups: DailyRollup[] = [];
  const missingDays: string[] = [];
  const truncated = new Set<GroupingSetName>();

  for (const day of days) {
    const rollup = await readRollupForDay(bucket, zoneId, day);
    if (rollup) {
      rollups.push(rollup);
      for (const set of rollup.truncatedGroupingSets ?? []) truncated.add(set);
    } else {
      missingDays.push(day);
    }
  }

  const totals: WindowTotals = {
    daysPresent: rollups.length,
    daysExpected: days.length,
    missingDays,
    truncatedGroupingSets: [...truncated],
    requestCount: sumRequests(rollups),
    bytes: sumBytes(rollups),
  };
  return { totals, rollups };
}

/** Round a percent change to a bounded precision. */
function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the supported metrics for a report from the two windows' totals. The
 * request-volume reduction is the only derived metric; everything else is
 * explicitly unavailable.
 */
export function buildMonitoringMetrics(pre: WindowTotals, post: WindowTotals): MonitoringMetric[] {
  const metrics: MonitoringMetric[] = [];

  metrics.push({
    metric: "request_count",
    available: true,
    value: post.requestCount,
    reason: "post-window request count from the verified_bot_country grouping set.",
  });
  metrics.push({
    metric: "bytes",
    available: true,
    value: post.bytes,
    reason: "post-window edge response bytes from the verified_bot_country grouping set.",
  });

  // Request-volume reduction is only reported when both windows have full
  // coverage; an incomplete pre/post window would make the ratio misleading.
  const comparable = pre.daysPresent === pre.daysExpected && post.daysPresent === post.daysExpected;
  if (comparable && pre.requestCount > 0) {
    const percentChange = roundPercent(((post.requestCount - pre.requestCount) / pre.requestCount) * 100);
    metrics.push({
      metric: "request_volume_reduction",
      available: true,
      value: post.requestCount - pre.requestCount,
      percentChange,
      reason:
        percentChange <= 0
          ? `request volume ${Math.abs(percentChange)}% lower post-application vs the equal-length pre window.`
          : `request volume ${percentChange}% higher post-application vs the equal-length pre window.`,
    });
  } else if (comparable && pre.requestCount === 0) {
    metrics.push({
      metric: "request_volume_reduction",
      available: true,
      value: post.requestCount,
      percentChange: undefined,
      reason: "pre-window request count was zero; reporting the absolute post-window count only.",
    });
  } else {
    metrics.push({
      metric: "request_volume_reduction",
      available: false,
      value: undefined,
      reason:
        "unavailable: the reduction ratio is only computed over equal, fully-covered pre/post windows.",
    });
  }

  // Explicitly unavailable metrics (never fabricated).
  for (const { metric, reason } of UNAVAILABLE_METRICS) {
    metrics.push({ metric, available: false, reason });
  }

  return metrics;
}

/**
 * Build a monitoring report for a recommendation at a checkpoint, or return
 * null when the checkpoint is NOT YET DUE.
 *
 * Windows are non-overlapping full UTC days (issue-corrected):
 *   pre  = the `count` full days ending at `appliedDay - 1`
 *   post = the `count` full days starting at `appliedDay + 1`
 * The applied day itself is never counted as either pre or post traffic, and
 * the post window is never backfilled with pre-application dates.
 *
 * `endDay` is REQUIRED and MUST be the latest completed UTC day (the signal's
 * endDay or the current completed day). The checkpoint is only computed when
 * `endDay >= postWindowEnd(appliedDay, count)`; otherwise it returns null and
 * is never run early. Missing R2 days inside a due window remain explicit
 * coverage gaps.
 */
export async function buildMonitoringReport(options: {
  bucket: R2Store;
  zoneId: string;
  hostname: string;
  recommendationId: string;
  cloudflareRuleId?: string;
  appliedAt: string;
  checkpoint: MonitoringCheckpoint;
  /** REQUIRED latest completed UTC day (signal endDay or current completed day). */
  endDay: string;
}): Promise<MonitoringReport | null> {
  const { bucket, zoneId, hostname, recommendationId, cloudflareRuleId, appliedAt, checkpoint, endDay } = options;
  const count = checkpointDays(checkpoint);

  const appliedDay = appliedAt.slice(0, 10);
  if (!isCheckpointDue(appliedDay, count, endDay)) {
    return null;
  }

  const preDays = preWindowDays(appliedDay, count);
  const postDays = postWindowDays(appliedDay, count);

  const { totals: pre } = await computeWindowTotals(bucket, zoneId, preDays);
  const { totals: post } = await computeWindowTotals(bucket, zoneId, postDays);

  const metrics = buildMonitoringMetrics(pre, post);
  const fullCoverage =
    pre.daysPresent === pre.daysExpected &&
    post.daysPresent === post.daysExpected &&
    pre.truncatedGroupingSets.length === 0 &&
    post.truncatedGroupingSets.length === 0;

  return {
    zoneId,
    hostname,
    recommendationId,
    cloudflareRuleId,
    appliedAt,
    checkpoint,
    endDay,
    preDays,
    postDays,
    pre,
    post,
    metrics,
    fullCoverage,
  };
}

/** Format a number with commas for rendering. */
function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** A stable outcome id for a checkpoint (dedupe / delivery recognition). */
export function outcomeId(zoneId: string, recommendationId: string, checkpoint: MonitoringCheckpoint): string {
  return `monitor-${zoneId}-${recommendationId}-${checkpoint}`;
}

/** Render a monitoring report as plain text. */
export function renderMonitoringText(report: MonitoringReport): string {
  const lines: string[] = [];
  lines.push(`Bot Traffic Impact Report — ${report.checkpoint} — ${report.hostname}`);
  lines.push(`Recommendation: ${report.recommendationId}`);
  if (report.cloudflareRuleId) lines.push(`Cloudflare rule: ${report.cloudflareRuleId}`);
  lines.push(`Applied: ${report.appliedAt}`);
  lines.push("");
  lines.push(
    `Pre window (${MONITOR_GROUPING_SET}, ${report.preDays.length} full day${
      report.preDays.length === 1 ? "" : "s"
    } before applied: ${report.preDays.join("..")}):`,
  );
  renderWindowText(lines, report.pre);
  lines.push("");
  lines.push(
    `Post window (${MONITOR_GROUPING_SET}, ${report.postDays.length} full day${
      report.postDays.length === 1 ? "" : "s"
    } after applied: ${report.postDays.join("..")}):`,
  );
  renderWindowText(lines, report.post);
  lines.push("");
  lines.push("Metrics:");
  for (const metric of report.metrics) {
    if (metric.available && metric.value !== undefined) {
      lines.push(
        `  - ${metric.metric}: ${formatNumber(metric.value)}${
          metric.percentChange !== undefined ? ` (${metric.percentChange}%)` : ""
        }`,
      );
    } else {
      lines.push(`  - ${metric.metric}: unavailable (${metric.reason})`);
    }
  }
  lines.push("");
  lines.push(
    report.fullCoverage
      ? "Coverage: full — both windows have complete, untruncated data."
      : "Coverage: partial — at least one window is missing days or truncated; compare with caution.",
  );
  lines.push("");
  lines.push(
    "Note: this report never fabricates unsupported metrics. Rule match count, challenge count/solve rate," +
      " search referral changes, origin error rate, and estimated cost reduction are reported unavailable.",
  );
  return lines.join("\n");
}

/** Render a window's coverage and totals as text lines. */
function renderWindowText(lines: string[], totals: WindowTotals): void {
  lines.push(`  Coverage: ${totals.daysPresent}/${totals.daysExpected} days`);
  if (totals.missingDays.length > 0) {
    lines.push(`  Missing days: ${totals.missingDays.join(", ")}`);
  }
  if (totals.truncatedGroupingSets.length > 0) {
    lines.push(`  Truncated grouping sets: ${totals.truncatedGroupingSets.join(", ")}`);
  }
  lines.push(`  Request count: ${formatNumber(totals.requestCount)}`);
  lines.push(`  Bytes: ${formatNumber(totals.bytes)}`);
}

/** Render a monitoring report as HTML. Every value is numeric or a fixed string. */
export function renderMonitoringHtml(report: MonitoringReport): string {
  const metricRows = report.metrics
    .map((m) => {
      const value =
        m.available && m.value !== undefined
          ? `${formatNumber(m.value)}${
              m.percentChange !== undefined ? ` (${m.percentChange}%)` : ""
            }`
          : "unavailable";
      return `<tr><td>${m.metric}</td><td>${value}</td><td>${m.reason}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Bot Traffic Impact Report — ${report.checkpoint}</title>
</head>
<body>
<h1>Bot Traffic Impact Report — ${report.checkpoint} — ${report.hostname}</h1>
<p>Recommendation: ${report.recommendationId}</p>
${report.cloudflareRuleId ? `<p>Cloudflare rule: ${report.cloudflareRuleId}</p>` : ""}
<p>Applied: ${report.appliedAt}</p>
<h2>Pre window (${MONITOR_GROUPING_SET})</h2>
<p>Coverage: ${report.pre.daysPresent}/${report.pre.daysExpected} days</p>
${report.pre.missingDays.length ? `<p>Missing days: ${report.pre.missingDays.join(", ")}</p>` : ""}
<p>Request count: ${formatNumber(report.pre.requestCount)}; bytes: ${formatNumber(report.pre.bytes)}</p>
<h2>Post window (${MONITOR_GROUPING_SET})</h2>
<p>Coverage: ${report.post.daysPresent}/${report.post.daysExpected} days</p>
${report.post.missingDays.length ? `<p>Missing days: ${report.post.missingDays.join(", ")}</p>` : ""}
<p>Request count: ${formatNumber(report.post.requestCount)}; bytes: ${formatNumber(report.post.bytes)}</p>
<h2>Metrics</h2>
<table>
<thead><tr><th>Metric</th><th>Value</th><th>Reason</th></tr></thead>
<tbody>
${metricRows}
</tbody>
</table>
<p>Coverage: ${report.fullCoverage ? "full" : "partial"}</p>
</body>
</html>`;
}