/**
 * Plain R2 daily rollup storage.
 *
 * The one-zone MVP writes one deterministic JSON rollup object per day to R2
 * under a stable key and reads them back directly for weekly analysis. Writes
 * are idempotent: re-running the same `(zone_id, day)` overwrites the object
 * (never appends), converging partial writes on the retry. Every object
 * carries a SHA-256 over its canonical content, and reads recompute and
 * compare it to detect corruption.
 *
 * `R2Store` is a minimal structural interface satisfied by the Workers
 * `R2Bucket`, so the storage logic is unit-testable with an in-memory fake.
 */

import { canonicalJson, sha256 } from "../shared/canonical.ts";
import type { DailyRollup } from "./types.ts";

/** Minimal R2 surface used by the analytics layer. */
export interface R2Store {
  head(key: string): Promise<{ key: string; size: number } | null>;
  get(key: string): Promise<{ text(): Promise<string>; json<T>(): Promise<T> } | null>;
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Object-key prefix for daily rollups. */
const ROLLUP_PREFIX = "rollups/";

/** Deterministic R2 key for one zone's one-day rollup. */
export function rollupKey(zoneId: string, day: string): string {
  return `${ROLLUP_PREFIX}${zoneId}/${day}.json`;
}

/** Extract the calendar day (YYYY-MM-DD) from a rollup key, or null. */
export function dayFromRollupKey(key: string): string | null {
  const match = key.match(new RegExp(`^${ROLLUP_PREFIX}[^/]+/(\\d{4}-\\d{2}-\\d{2})\\.json$`));
  return match ? match[1] : null;
}

/** List rollup keys for a zone, paging through R2 cursors. */
export async function listRollupKeys(bucket: R2Store, zoneId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: `${ROLLUP_PREFIX}${zoneId}/`,
      cursor,
    });
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** List the calendar days for which a zone already has a rollup. */
export async function listRollupDays(bucket: R2Store, zoneId: string): Promise<Set<string>> {
  const days = new Set<string>();
  for (const key of await listRollupKeys(bucket, zoneId)) {
    const day = dayFromRollupKey(key);
    if (day) days.add(day);
  }
  return days;
}

/** Serialize a rollup deterministically. The object is already canonical. */
function rollupBody(rollup: DailyRollup): string {
  return canonicalJson(rollup);
}

/** Recompute and compare the stored SHA-256. Throws on mismatch or absence. */
export function verifyRollupIntegrity(rollup: DailyRollup): void {
  const expected = rollup.sha256;
  if (!expected) {
    throw new Error(`rollup for ${rollup.day} is missing a sha256 integrity hash`);
  }
  const { sha256: _hash, ...content } = rollup;
  if (sha256(content) !== expected) {
    throw new Error(`rollup for ${rollup.day} failed SHA-256 integrity verification`);
  }
}

/**
 * Write a daily rollup to R2 idempotently: the key is deterministic and the
 * write is a plain overwrite, so a retried run converges. The object's own
 * `sha256` field is the integrity hash over its canonical content.
 */
export async function writeDayRollup(
  bucket: R2Store,
  rollup: DailyRollup,
): Promise<void> {
  const key = rollupKey(rollup.zoneId, rollup.day);
  await bucket.put(key, rollupBody(rollup), {
    customMetadata: {
      zoneId: rollup.zoneId,
      day: rollup.day,
      sha256: rollup.sha256,
      collectorVersion: rollup.collectorVersion,
    },
  });
}

/**
 * Read and verify one day's rollup by key. Returns null when absent; throws
 * when present but corrupt (integrity mismatch).
 */
export async function readDayRollup(
  bucket: R2Store,
  key: string,
): Promise<DailyRollup | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const rollup = (await object.json()) as DailyRollup;
  verifyRollupIntegrity(rollup);
  return rollup;
}

/** Read and verify a zone's rollup for a specific calendar day. */
export async function readRollupForDay(
  bucket: R2Store,
  zoneId: string,
  day: string,
): Promise<DailyRollup | null> {
  return readDayRollup(bucket, rollupKey(zoneId, day));
}