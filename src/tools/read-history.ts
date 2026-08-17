/**
 * Agent tool: read recent traffic history from R2.
 *
 * Returns a bounded, sanitized summary the model can cite, along with the
 * runtime capability matrix so unsupported metrics stay out of findings.
 * Traffic-derived strings are truncated before being returned to the model.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { SEVEN_DAY_WINDOW, readHistory } from "../analytics/reader.ts";
import { supportedMetrics } from "../analytics/capability.ts";
import { flattenCells } from "../analytics/report.ts";
import { truncateTrafficString } from "../analytics/sanitization.ts";
import type { R2Store } from "../analytics/storage.ts";
import type { DailyRollup, GroupingSetName } from "../analytics/types.ts";
import { yesterdayIso } from "../shared/dates.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

/** A compact, bounded row for the model. Labels are already truncated. */
export interface HistorySummaryRow {
  dimensions: Record<string, string | boolean | number | null>;
  requestCount: number;
  bytes: number;
}

export interface ReadHistoryToolDeps {
  zoneId: string;
  resolveBucket: () => R2Store;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<ZoneContext, "resolveZoneConfig" | "resolveBucket">;
}

const inputSchema = v.object({
  days: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(SEVEN_DAY_WINDOW)),
  ),
  /** The zone to read history for (validated against D1). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  zoneId: v.string(),
  endDay: v.string(),
  daysRequested: v.number(),
  daysPresent: v.number(),
  missingDays: v.array(v.string()),
  groupingSets: v.record(v.string(), v.array(v.unknown())),
  truncatedGroupingSets: v.array(v.string()),
  capability: v.array(v.string()),
});

/**
 * Summarize rollups into a bounded per-grouping-set top-N list with totals.
 */
export function summarizeRollups(rollups: DailyRollup[]): Record<string, HistorySummaryRow[]> {
  const groupingSets: GroupingSetName[] = [
    "verified_bot_country",
    "ua_verified_bot",
    "path_status",
    "source_country",
  ];
  const summary: Record<string, HistorySummaryRow[]> = {};

  for (const groupingSet of groupingSets) {
    const cells = flattenCells(rollups, groupingSet);
    const rows = mergeCellsIntoRows(cells)
      .sort((a, b) => b.requestCount - a.requestCount)
      .slice(0, 10)
      .map(({ dimensions, requestCount, bytes }) => ({
        // Traffic-derived dimension strings are untrusted; truncate before
        // returning them to the model.
        dimensions: truncateDimensionStrings(dimensions),
        requestCount,
        bytes,
      }));
    summary[groupingSet] = rows;
  }
  return summary;
}

/** Truncate string dimension values (traffic fields) to a bounded length. */
function truncateDimensionStrings(
  dimensions: Record<string, string | boolean | number | null>,
): Record<string, string | boolean | number | null> {
  const out: Record<string, string | boolean | number | null> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    out[key] = typeof value === "string" ? truncateTrafficString(value) : value;
  }
  return out;
}

/** Merge cells with identical dimension keys, summing metrics. */
function mergeCellsIntoRows(
  cells: { dimensions: Record<string, string | boolean | number | null>; requestCount: number; bytes: number }[],
): { dimensions: Record<string, string | boolean | number | null>; requestCount: number; bytes: number }[] {
  const byKey = new Map<string, {
    dimensions: Record<string, string | boolean | number | null>;
    requestCount: number;
    bytes: number;
  }>();
  for (const cell of cells) {
    const key = Object.entries(cell.dimensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, value]) => `${k}=${String(value)}`)
      .join("&");
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

/** Factory for the read-history tool, wired to a zone and an R2 resolver. */
export function createReadHistoryTool({ zoneId, resolveBucket, zoneContext }: ReadHistoryToolDeps) {
  return defineTool({
    name: "read_traffic_history",
    description:
      "Read the most recent daily traffic rollups for a zone from R2 and return a bounded, sanitized summary plus the runtime capability matrix. Use this to ground any traffic claim in collected data. Optionally pass zoneId; defaults to the zone this agent manages. Do not fabricate metrics the capability matrix marks unsupported.",
    input: inputSchema,
    output: outputSchema,
    run: async ({ data }) => {
      // Resolve the target zone from the model-supplied zoneId (if any)
      // against D1, else fall back to the mounted default. Only zone id and days
      // come from the model; the bucket is always the application's own R2.
      const target = zoneContext
        ? await resolveTargetZone(zoneContext, data.zoneId, zoneId)
        : { zoneId };
      const targetZoneId = target.zoneId;
      const bucket = zoneContext
        ? zoneContext.resolveBucket(targetZoneId)
        : resolveBucket();
      // Rollups only exist for completed UTC days; end on yesterday.
      const endDay = yesterdayIso();
      const days = data.days ?? SEVEN_DAY_WINDOW;
      const { rollups, missingDays } = await readHistory(bucket, targetZoneId, endDay, days);

      const truncated = new Set<GroupingSetName>();
      for (const rollup of rollups) {
        for (const set of rollup.truncatedGroupingSets ?? []) truncated.add(set);
      }

      return {
        output: {
          zoneId: targetZoneId,
          endDay,
          daysRequested: days,
          daysPresent: rollups.length,
          missingDays,
          groupingSets: summarizeRollups(rollups),
          truncatedGroupingSets: [...truncated],
          capability: supportedMetrics(),
        },
      };
    },
  });
}