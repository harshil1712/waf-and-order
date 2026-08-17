/**
 * Analytics types for the plain-R2 daily rollup path.
 *
 * The one-zone MVP stores one deterministic JSON rollup object per day in R2
 * and reads them back directly for weekly analysis.
 */

/** A supported multidimensional grouping set name. */
export type GroupingSetName =
  | "verified_bot_country"
  | "ua_verified_bot"
  | "path_status"
  | "source_country";

/** All grouping sets the collector collects. Selected, non-overlapping, and backed only by capability-confirmed dimensions. */
export const GROUPING_SETS: GroupingSetName[] = [
  "verified_bot_country",
  "ua_verified_bot",
  "path_status",
  "source_country",
];

/**
 * A single cell of the multidimensional rollup cube. The `groupingSet` name
 * identifies the exact shape that produced this row so queries never sum
 * overlapping rollups.
 */
export interface RollupCell {
  groupingSet: GroupingSetName;
  dimensions: Record<string, string | boolean | number | null>;
  requestCount: number;
  bytes: number;
}

/** One daily rollup object, written idempotently under a deterministic R2 key. */
export interface DailyRollup {
  schemaVersion: 1;
  zoneId: string;
  hostname: string;
  day: string;
  periodStart: string;
  periodEnd: string;
  collectedAt: string;
  collectorVersion: string;
  groupingSets: Partial<Record<GroupingSetName, RollupCell[]>>;
  /**
   * Grouping sets whose returned row count reached the query limit. Totals for
   * these grouping sets are NOT complete; reports must surface this instead of
   * presenting them as full totals.
   */
  truncatedGroupingSets: GroupingSetName[];
  /** SHA-256 of the canonicalized content of this object (without this field). */
  sha256: string;
}