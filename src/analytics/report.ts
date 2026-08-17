/**
 * Weekly report rendering.
 *
 * Aggregates the seven-day rollup history into findings and renders HTML and
 * plain-text versions. Every metric is drawn only from capability-confirmed
 * sources (capability.ts); unsupported metrics (sequential traversal,
 * distributed-IP correlation, challenge solve rate) are explicitly omitted,
 * never fabricated. All traffic-derived strings (paths, user agents, sources,
 * countries) are truncated for persistence and HTML-escaped for rendering
 * (sanitization.ts) to prevent markup injection.
 */

import { CAPABILITY_MATRIX, CONFIRMED_DIMENSIONS, type CapabilityClaim } from "./capability.ts";
import type { DailyRollup, GroupingSetName, RollupCell } from "./types.ts";
import { escapeHtml, truncateTrafficString } from "./sanitization.ts";

/** Top-N buckets kept per dimension in a report. */
const REPORT_TOP_N = 10;

/** One aggregate observation: a named metric, its grouping set, and value. */
export interface ReportObservation {
  groupingSet: GroupingSetName;
  /** The metric name, one of the capability-supported metrics. */
  metric: "request_count" | "bytes";
  label: string;
  value: number;
}

/** The structured report model produced from a seven-day window. */
export interface WeeklyReportData {
  zoneId: string;
  hostname: string;
  startDay: string;
  endDay: string;
  generatedAt: string;
  reportId: string;
  /** Number of days present in the window (missing days are reported, not assumed). */
  daysPresent: number;
  daysExpected: number;
  missingDays: string[];
  observations: ReportObservation[];
  /** Top rows per grouping set, with traffic strings truncated (not escaped). */
  topByGroupingSet: Partial<Record<GroupingSetName, ReportRow[]>>;
  /**
   * Grouping sets truncated at collection time in at least one day. Totals for
   * these grouping sets are incomplete and must be surfaced, not presented as
   * complete.
   */
  truncatedGroupingSets: GroupingSetName[];
  /** Capability claims included so reports state what is supported/omitted. */
  capability: readonly CapabilityClaim[];
  /** Total request count across the window's verified_bot_country grouping set. */
  totalRequests: number;
  /** Total bytes across the window's verified_bot_country grouping set. */
  totalBytes: number;
}

/** A bounded top-N row: a dimension label plus one or more metric values. */
export interface ReportRow {
  label: string;
  requestCount: number;
  bytes: number;
}

/** Build a stable report id for deduplication/recognition. */
export function reportIdFor(zoneId: string, endDay: string, startDay: string): string {
  return `report-${zoneId}-${startDay}-${endDay}`;
}

/** Flatten the window's cells for one grouping set into rows. */
export function flattenCells(
  rollups: DailyRollup[],
  groupingSet: GroupingSetName,
): RollupCell[] {
  const cells: RollupCell[] = [];
  for (const rollup of rollups) {
    cells.push(...(rollup.groupingSets[groupingSet] ?? []));
  }
  return cells;
}

/** Merge cells sharing identical dimension values into one row. */
function mergeCells(cells: RollupCell[]): RollupCell[] {
  const byKey = new Map<string, RollupCell>();
  for (const cell of cells) {
    const key = canonicalDimensionKey(cell.dimensions);
    const existing = byKey.get(key);
    if (existing) {
      existing.requestCount += cell.requestCount;
      existing.bytes += cell.bytes;
    } else {
      byKey.set(key, { ...cell, dimensions: { ...cell.dimensions } });
    }
  }
  return [...byKey.values()];
}

function canonicalDimensionKey(dimensions: Record<string, string | boolean | number | null>): string {
  return Object.entries(dimensions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

/** Pick a human label for a row from its dimension values (already truncated). */
function labelForDimensions(dimensions: Record<string, string | boolean | number | null>): string {
  const parts: string[] = [];
  for (const key of CONFIRMED_DIMENSIONS) {
    if (key in dimensions && dimensions[key] != null) {
      parts.push(`${key}: ${dimensions[key]}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "unknown";
}

/** Build top-N rows for a grouping set, sorted by request count descending. */
function topRows(
  rollups: DailyRollup[],
  groupingSet: GroupingSetName,
  topN: number,
): ReportRow[] {
  const merged = mergeCells(flattenCells(rollups, groupingSet));
  return merged
    .sort((a, b) => b.requestCount - a.requestCount)
    .slice(0, topN)
    .map((cell) => ({
      label: labelForDimensions(cell.dimensions),
      requestCount: cell.requestCount,
      bytes: cell.bytes,
    }));
}

/** Build a top-N row set, retaining only unique labels (bounded output). */
function dedupeRows(rows: ReportRow[]): ReportRow[] {
  const seen = new Set<string>();
  const out: ReportRow[] = [];
  for (const row of rows) {
    if (seen.has(row.label)) continue;
    seen.add(row.label);
    out.push(row);
    if (out.length >= REPORT_TOP_N) break;
  }
  return out;
}

/** Aggregate a single metric across a grouping set's cells. */
function sumMetric(
  rollups: DailyRollup[],
  groupingSet: GroupingSetName,
  metric: ReportObservation["metric"],
): number {
  const cells = flattenCells(rollups, groupingSet);
  if (metric === "request_count") return cells.reduce((sum, c) => sum + c.requestCount, 0);
  return cells.reduce((sum, c) => sum + c.bytes, 0);
}

/**
 * Build the structured weekly report data. Only capability-supported metrics
 * are aggregated (request_count, bytes). Grouping sets truncated at collection
 * time are surfaced so totals are not presented as complete.
 */
export function buildWeeklyReport(
  rollups: DailyRollup[],
  options: { zoneId: string; hostname: string; endDay: string; startDay: string; generatedAt: string },
): WeeklyReportData {
  const daysPresent = rollups.length;
  const daysExpected = lastNInclusive(options.startDay, options.endDay).length;
  const present = new Set(rollups.map((r) => r.day));
  const missingDays = lastNInclusive(options.startDay, options.endDay).filter(
    (d) => !present.has(d),
  );

  const observations: ReportObservation[] = [];
  observations.push({
    groupingSet: "verified_bot_country",
    metric: "request_count",
    label: "total_request_count",
    value: sumMetric(rollups, "verified_bot_country", "request_count"),
  });
  observations.push({
    groupingSet: "verified_bot_country",
    metric: "bytes",
    label: "total_edge_response_bytes",
    value: sumMetric(rollups, "verified_bot_country", "bytes"),
  });

  // A grouping set is truncated if any day in the window reached the cap.
  const truncatedGroupingSets: GroupingSetName[] = [];
  const seenTruncated = new Set<GroupingSetName>();
  for (const rollup of rollups) {
    for (const set of rollup.truncatedGroupingSets ?? []) {
      if (!seenTruncated.has(set)) {
        seenTruncated.add(set);
        truncatedGroupingSets.push(set);
      }
    }
  }

  const topByGroupingSet: WeeklyReportData["topByGroupingSet"] = {
    verified_bot_country: dedupeRows(topRows(rollups, "verified_bot_country", REPORT_TOP_N)),
    ua_verified_bot: dedupeRows(topRows(rollups, "ua_verified_bot", REPORT_TOP_N)),
    path_status: dedupeRows(topRows(rollups, "path_status", REPORT_TOP_N)),
    source_country: dedupeRows(topRows(rollups, "source_country", REPORT_TOP_N)),
  };

  return {
    zoneId: options.zoneId,
    hostname: options.hostname,
    startDay: options.startDay,
    endDay: options.endDay,
    generatedAt: options.generatedAt,
    reportId: reportIdFor(options.zoneId, options.endDay, options.startDay),
    daysPresent,
    daysExpected,
    missingDays,
    observations,
    topByGroupingSet,
    truncatedGroupingSets,
    capability: SUPPORTED_CLAIMS,
    totalRequests: sumMetric(rollups, "verified_bot_country", "request_count"),
    totalBytes: sumMetric(rollups, "verified_bot_country", "bytes"),
  };
}

/** The capability claims reported (supported + explicitly omitted). */
const SUPPORTED_CLAIMS = CAPABILITY_MATRIX;

/** Inclusive list of days between start and end (oldest first). */
function lastNInclusive(start: string, end: string): string[] {
  const days: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    days.push(cursor);
    const next = new Date(`${cursor}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }
  return days;
}

/** Render one metric value with commas. */
function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** Render the report as plain text. All labels are already truncated. */
export function renderReportText(report: WeeklyReportData): string {
  const lines: string[] = [];
  lines.push(`Bot Traffic Weekly Report — ${report.hostname} (${report.zoneId})`);
  lines.push(`Window: ${report.startDay} .. ${report.endDay}`);
  lines.push(`Coverage: ${report.daysPresent}/${report.daysExpected} days`);
  if (report.missingDays.length > 0) {
    lines.push(`Missing days (no rollup found): ${report.missingDays.join(", ")}`);
  }
  if (report.truncatedGroupingSets.length > 0) {
    lines.push(
      `Truncated grouping sets (totals incomplete): ${report.truncatedGroupingSets.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("Metrics (capability-confirmed only):");
  for (const obs of report.observations) {
    lines.push(`  - ${obs.label}: ${formatNumber(obs.value)}`);
  }
  lines.push("");

  const topKeys: GroupingSetName[] = [
    "verified_bot_country",
    "ua_verified_bot",
    "path_status",
    "source_country",
  ];
  for (const key of topKeys) {
    const rows = report.topByGroupingSet[key] ?? [];
    if (rows.length === 0) continue;
    lines.push(`${key} (top ${rows.length}):`);
    for (const row of rows) {
      const label = truncateTrafficString(row.label);
      lines.push(`  - ${label}: ${formatNumber(row.requestCount)} requests, ${formatNumber(row.bytes)} bytes`);
    }
    lines.push("");
  }

  lines.push("Capability matrix (metrics omitted when unsupported):");
  for (const claim of report.capability) {
    lines.push(`  - ${claim.metric}: ${claim.supported ? "supported" : "omitted"} (${claim.reason})`);
  }

  lines.push("");
  lines.push(`Report id: ${report.reportId}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push(
    'Note: the "likely legitimate traffic exposure" heuristic is not measured here; ' +
      "this report includes only capability-confirmed metrics. No WAF changes are proposed.",
  );
  return lines.join("\n");
}

/** Escape a label for HTML rendering. */
function escapeLabel(label: string): string {
  return escapeHtml(truncateTrafficString(label));
}

/** Render the report as HTML. Every traffic string is escaped + truncated. */
export function renderReportHtml(report: WeeklyReportData): string {
  const topKeys: GroupingSetName[] = [
    "verified_bot_country",
    "ua_verified_bot",
    "path_status",
    "source_country",
  ];

  const rowsHtml = topKeys
    .map((key) => {
      const rows = report.topByGroupingSet[key] ?? [];
      if (rows.length === 0) return "";
      const body = rows
        .map((row) => {
          return `<tr><td>${escapeLabel(row.label)}</td><td>${formatNumber(
            row.requestCount,
          )}</td><td>${formatNumber(row.bytes)}</td></tr>`;
        })
        .join("\n");
      return `<h3>${escapeHtml(key)}</h3>
<table>
<thead><tr><th>Dimension</th><th>Requests</th><th>Bytes</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
    })
    .join("\n");

  const missingHtml =
    report.missingDays.length > 0
      ? `<p><strong>Missing days (no rollup found):</strong> ${escapeHtml(
          report.missingDays.join(", "),
        )}</p>`
      : "";

  const truncationHtml =
    report.truncatedGroupingSets.length > 0
      ? `<p><strong>Truncated grouping sets (totals incomplete):</strong> ${escapeHtml(
          report.truncatedGroupingSets.join(", "),
        )}</p>`
      : "";

  const metricsHtml = report.observations
    .map(
      (obs) =>
        `<li><strong>${escapeHtml(obs.label)}:</strong> ${formatNumber(obs.value)}</li>`,
    )
    .join("\n");

  const capabilityHtml = report.capability
    .map(
      (claim) =>
        `<li>${escapeHtml(claim.metric)}: ${
          claim.supported ? "supported" : "omitted"
        } <em>(${escapeHtml(claim.reason)})</em></li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Bot Traffic Weekly Report</title>
</head>
<body>
<h1>Bot Traffic Weekly Report — ${escapeHtml(report.hostname)}</h1>
<p>Zone: ${escapeHtml(report.zoneId)}</p>
<p>Window: ${escapeHtml(report.startDay)} .. ${escapeHtml(report.endDay)}</p>
<p>Coverage: ${report.daysPresent}/${report.daysExpected} days</p>
${missingHtml}
${truncationHtml}
<h2>Metrics</h2>
<ul>
${metricsHtml}
</ul>
${rowsHtml}
<h2>Capability matrix</h2>
<ul>
${capabilityHtml}
</ul>
<p>Report id: ${escapeHtml(report.reportId)}</p>
<p>Generated: ${escapeHtml(report.generatedAt)}</p>
<p><em>This report includes only capability-confirmed metrics. No WAF changes are proposed.</em></p>
</body>
</html>`;
}