/**
 * Bounded gap backfill.
 *
 * Detect missing `(zone_id, day)` periods within a small, fixed window and
 * collect them, bounded so an outage does not trigger unbounded historical
 * replay. The daily scheduled handler calls this after collecting the most
 * recent day.
 */

import { collectDay, type DayCellsFetcher } from "./collector.ts";
import type { DailyRollup } from "./types.ts";
import {
  listRollupDays,
  rollupKey,
  writeDayRollup,
  type R2Store,
} from "./storage.ts";

/** Default backfill window: only the last 14 days are ever considered. */
export const DEFAULT_BACKFILL_WINDOW_DAYS = 14;

/** Add one day to a YYYY-MM-DD calendar string. */
export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

/** The inclusive list of calendar days from `start` to `end` (inclusive). */
export function daysInRange(start: string, end: string): string[] {
  const days: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** The first day of the bounded window ending at `endDay`. */
export function windowStart(endDay: string, windowDays: number): string {
  return addDays(endDay, -(windowDays - 1));
}

/** Days missing from `existing` within `[startDay, endDay]`, oldest first. */
export function computeMissingDays(
  existing: ReadonlySet<string>,
  startDay: string,
  endDay: string,
): string[] {
  return daysInRange(startDay, endDay).filter((day) => !existing.has(day));
}

/**
 * Backfill missing days within a bounded window. For each missing day it
 * collects and writes a rollup, then returns the list of days backfilled.
 */
export async function runBoundedBackfill(options: {
  bucket: R2Store;
  zoneId: string;
  hostname: string;
  endDay: string;
  windowDays?: number;
  fetcher: DayCellsFetcher;
}): Promise<string[]> {
  const { bucket, zoneId, hostname, endDay, fetcher } = options;
  const windowDays = options.windowDays ?? DEFAULT_BACKFILL_WINDOW_DAYS;

  const existing = await listRollupDays(bucket, zoneId);
  const missing = computeMissingDays(existing, windowStart(endDay, windowDays), endDay);

  const backfilled: string[] = [];
  for (const day of missing) {
    const rollup: DailyRollup = await collectDay({ zoneId, hostname, day, fetcher });
    await writeDayRollup(bucket, rollup);
    backfilled.push(day);
  }
  return backfilled;
}