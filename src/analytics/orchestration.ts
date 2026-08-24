/**
 * Daily collection orchestration.
 *
 * Deterministic code run from the source-root daily scheduled handler: collect
 * the previous completed day via GraphQL, write the idempotent R2 rollup, then
 * run bounded gap backfill. The handler then dispatches a completion signal to
 * the zone agent. This module is kept pure of dispatch so it is unit-testable
 * with a fake bucket and fetcher.
 */

import { collectDay } from "./collector.ts";
import { queryGraphQL } from "./graphql.ts";
import { runBoundedBackfill } from "./backfill.ts";
import { writeDayRollup, type R2Store } from "./storage.ts";
import { yesterdayIso } from "../shared/dates.ts";
import type { ZoneConfig } from "../registry/zone-registry.ts";

/**
 * The bindings the daily collection needs. Only the R2 bucket is narrowed to
 * the structural `R2Store` surface so unit tests can substitute an in-memory
 * fake. Zone vars are supplied per-zone as a registry row, never read
 * from global TARGET_* vars.
 */
export type CollectionEnv = {
  BOT_TRAFFIC_ANALYTICS: R2Store;
};

/** The result of a daily collection run. */
export interface CollectionRun {
  day: string;
  backfilledDays: string[];
}

/** The shared read-only Cloudflare token is read from the Worker secret at run time. */
function analyticsToken(): string {
  const token = process.env.CLOUDFLARE_READ_TOKEN;
  if (!token) {
    throw new Error("CLOUDFLARE_READ_TOKEN is not set; cannot collect analytics.");
  }
  return token;
}

/**
 * Run daily collection + bounded backfill against the real GraphQL API for a
 * single zone registry row. Collects yesterday, writes its rollup, then
 * backfills any missing days within the bounded window ending at yesterday.
 */
export async function runDailyCollection(
  env: CollectionEnv,
  zone: ZoneConfig,
): Promise<CollectionRun> {
  const token = analyticsToken();
  const zoneId = zone.zoneId;
  const hostname = zone.hostname;
  const bucket = env.BOT_TRAFFIC_ANALYTICS;
  const fetcher = (query: string, variables: Record<string, unknown>) =>
    queryGraphQL(token, query, variables);

  const day = yesterdayIso();

  const rollup = await collectDay({ zoneId, hostname, day, fetcher });
  await writeDayRollup(bucket, rollup);

  const backfilledDays = await runBoundedBackfill({
    bucket,
    zoneId,
    hostname,
    endDay: day,
    fetcher,
  });

  return { day, backfilledDays };
}