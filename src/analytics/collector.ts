/**
 * Deterministic daily GraphQL collection.
 *
 * For a target zone and a single calendar day it issues one capability-scoped
 * query per selected non-overlapping grouping set, each with a
 * one-day window, and assembles a {@link DailyRollup}. Only capability-confirmed
 * dimensions and aggregations are projected (live probe, capability.ts). A
 * grouping set whose row count reaches the query limit is recorded as
 * truncated so reports never present partial totals as complete.
 *
 * `collectDay` is deliberately a pure orchestrator: it accepts a fetcher so
 * tests can drive it with canned GraphQL payloads, and the scheduled handler
 * wires the real `queryGraphQL` + token. The collector performs no mutation —
 * writing to R2 is the storage module's responsibility (idempotent overwrite,
 * SHA-256 integrity).
 */

import { assertDimensionsConfirmed, dimensionsBlock } from "./dimensions.ts";
import { sanitizeDimensionValue } from "./sanitization.ts";
import {
  GROUPING_SETS,
  type DailyRollup,
  type GroupingSetName,
  type RollupCell,
} from "./types.ts";
import { sha256 } from "../shared/canonical.ts";
import type { AdaptiveGroupsRow } from "./graphql.ts";

/** Bumped when the collected shape or query changes. Stored in each rollup. */
const COLLECTOR_VERSION = "phase1.2.0";

/**
 * Max rows returned per grouping-set query. When a response reaches this cap
 * the collector marks the grouping set truncated so reports never present the
 * totals as complete.
 */
export const MAX_CELLS_PER_GROUPING = 5000;

/**
 * A fetcher that returns the raw GraphQL Analytics body for one query. The
 * real implementation is `queryGraphQL(token, ...)` from graphql.ts; tests
 * substitute a canned fetcher.
 */
export type DayCellsFetcher = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

/** A single grouping-set query for one day. */
export interface GroupQuery {
  groupingSet: GroupingSetName;
  query: string;
  variables: Record<string, unknown>;
}

/** Build the one-day time-window filter for a calendar day (YYYY-MM-DD). */
export function dayWindow(day: string): { start: string; end: string } {
  return { start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z` };
}

/**
 * Build the GraphQL query for one grouping set over one day. `dimensionsBlock`
 * projects only capability-confirmed dimensions; aggregations are limited to
 * `count` and `sum(edgeResponseBytes)`. The `uniq` aggregation is NOT projected
 * because it is an unknown field on this plan (live probe).
 */
export function buildGroupQuery(
  zoneId: string,
  day: string,
  groupingSet: GroupingSetName,
): GroupQuery {
  assertDimensionsConfirmed();
  const { start, end } = dayWindow(day);
  const dimensions = dimensionsBlock(groupingSet);
  const query = `query DayCells($zoneTag: String!, $limit: Int!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        filter: { datetime_geq: "${start}", datetime_leq: "${end}" }
        limit: $limit
      ) {
        count
        sum { edgeResponseBytes }
        dimensions { ${dimensions} }
      }
    }
  }
}`;
  return {
    groupingSet,
    query,
    variables: { zoneTag: zoneId, limit: MAX_CELLS_PER_GROUPING },
  };
}

/** Build the full set of one-day grouping-set queries for a zone. */
export function buildDayQueries(zoneId: string, day: string): GroupQuery[] {
  return GROUPING_SETS.map((groupingSet) => buildGroupQuery(zoneId, day, groupingSet));
}

/**
 * Normalize one adaptive-groups row into a {@link RollupCell}. Dimension
 * values are truncated (untrusted traffic strings); numbers pass through.
 */
export function toCell(
  row: AdaptiveGroupsRow,
  groupingSet: GroupingSetName,
): RollupCell {
  const dimensions: Record<string, string | boolean | number | null> = {};
  if (row.dimensions) {
    for (const [key, value] of Object.entries(row.dimensions)) {
      dimensions[key] = sanitizeDimensionValue(key, value ?? null);
    }
  }
  const cell: RollupCell = {
    groupingSet,
    dimensions,
    requestCount: row.count ?? 0,
    bytes: row.sum?.edgeResponseBytes ?? 0,
  };
  return cell;
}

/** Normalize a raw GraphQL body into per-grouping-set cell arrays. */
export function parseDayCells(raw: unknown): Partial<Record<GroupingSetName, RollupCell[]>> {
  const groups = (raw as {
    data?: {
      viewer?: { zones?: { httpRequestsAdaptiveGroups?: AdaptiveGroupsRow[] }[] };
    };
  })?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;

  if (!groups) {
    return {};
  }

  // A single response contains rows for one grouping set. Map rows to cells
  // under that grouping set by inspecting each row's projected dimension keys.
  const grouped: Partial<Record<GroupingSetName, RollupCell[]>> = {};
  for (const row of groups) {
    const set = groupingSetForRow(row);
    if (!set) continue;
    (grouped[set] ??= []).push(toCell(row, set));
  }
  return grouped;
}

/**
 * Determine which grouping set a row belongs to from the set of dimension keys
 * it carries. Each grouping set has a distinct, non-overlapping projection, so
 * the key set uniquely identifies it.
 */
function groupingSetForRow(row: AdaptiveGroupsRow): GroupingSetName | null {
  const keys = Object.keys(row.dimensions ?? {}).sort().join(",");
  switch (keys) {
    case "clientCountryName,verifiedBotCategory":
      return "verified_bot_country";
    case "userAgent,verifiedBotCategory":
      return "ua_verified_bot";
    case "clientRequestPath,edgeResponseStatus":
      return "path_status";
    case "clientCountryName,requestSource":
      return "source_country";
    default:
      return null;
  }
}

/** Compute the SHA-256 over the canonical rollup content (excluding `sha256`). */
export function rollupSha256(rollup: Omit<DailyRollup, "sha256">): string {
  return sha256(rollup);
}

/**
 * Collect one day: run every grouping-set query, normalize cells, and assemble
 * a deterministic {@link DailyRollup} with its integrity hash. Pure — the
 * caller persists it via the storage module.
 *
 * `collectedAt` is an optional explicit ISO timestamp. It is part of the
 * hashed content, so callers that need byte-for-byte determinism (e.g. tests)
 * should pass a fixed value; the daily scheduled handler defaults to now.
 */
export async function collectDay(options: {
  zoneId: string;
  hostname: string;
  day: string;
  fetcher: DayCellsFetcher;
  collectedAt?: string;
}): Promise<DailyRollup> {
  const { zoneId, hostname, day, fetcher } = options;
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const groupingSets: DailyRollup["groupingSets"] = {};
  const truncatedGroupingSets: GroupingSetName[] = [];

  for (const { groupingSet, query, variables } of buildDayQueries(zoneId, day)) {
    const raw = await fetcher(query, variables);
    const cells = parseDayCells(raw)[groupingSet] ?? [];
    groupingSets[groupingSet] = cells;
    // If the response filled the cap, the grouping set's totals are not
    // complete; record it so reports surface the truncation.
    if (cells.length >= MAX_CELLS_PER_GROUPING) {
      truncatedGroupingSets.push(groupingSet);
    }
  }

  const { start, end } = dayWindow(day);
  const withoutHash: Omit<DailyRollup, "sha256"> = {
    schemaVersion: 1,
    zoneId,
    hostname,
    day,
    periodStart: start,
    periodEnd: end,
    collectedAt,
    collectorVersion: COLLECTOR_VERSION,
    groupingSets,
    truncatedGroupingSets,
  };

  return { ...withoutHash, sha256: rollupSha256(withoutHash) };
}
