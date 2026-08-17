/**
 * Seven-day history reader.
 *
 * The weekly analysis reads the last seven days of rollups directly from R2
 * daily objects using the plain-R2 storage path. Reads verify each
 * object's SHA-256 and skip missing days rather than fabricating them.
 */

import { addDays } from "./backfill.ts";
import type { DailyRollup } from "./types.ts";
import { readRollupForDay, type R2Store } from "./storage.ts";

/** The weekly report reads a seven-day window. */
export const SEVEN_DAY_WINDOW = 7;

/** The inclusive list of days ending at `endDay` (oldest first). */
export function lastNDays(endDay: string, count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(addDays(endDay, -i));
  }
  return days;
}

/**
 * Read and verify the rollups for the last `days` days ending at `endDay`.
 * Missing days are skipped (returned as a set) so reports state coverage
 * explicitly rather than fabricating absent data.
 */
export async function readHistory(
  bucket: R2Store,
  zoneId: string,
  endDay: string,
  days = SEVEN_DAY_WINDOW,
): Promise<{ rollups: DailyRollup[]; missingDays: string[] }> {
  const rollups: DailyRollup[] = [];
  const missingDays: string[] = [];

  for (const day of lastNDays(endDay, days)) {
    const rollup = await readRollupForDay(bucket, zoneId, day);
    if (rollup) {
      rollups.push(rollup);
    } else {
      missingDays.push(day);
    }
  }
  return { rollups, missingDays };
}
