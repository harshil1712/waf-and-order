/**
 * Pure per-zone cron dispatch loops.
 *
 * The scheduled handler in `src/cloudflare.ts` runs these loops against the D1
 * zone registry. They are PURE (no Flue/agent imports) so they are
 * unit-testable in a plain Node environment. Each loop ISOLATES per-zone
 * failures: a throwing collect/dispatch for one zone is recorded and the loop
 * continues, so one zone cannot starve the remaining enabled zones.
 */

import type { ZoneRegistryRepository } from "../registry/d1.ts";
import type { ZoneConfig } from "../registry/zone-registry.ts";

/** One zone's outcome from a per-zone cron loop. */
export interface ZoneCronResult {
  zoneId: string;
  ok: boolean;
  error?: string;
}

/**
 * Run a per-zone dispatch loop that ISOLATES per-zone failures: a throwing
 * dispatch for one zone is recorded and the loop continues, so one zone cannot
 * starve the remaining enabled zones. Returns a structured result array for
 * tests/observability rather than silently swallowing or aborting.
 */
export async function runDispatchCron(
  registry: ZoneRegistryRepository,
  dispatchOne: (zone: ZoneConfig) => Promise<unknown>,
): Promise<ZoneCronResult[]> {
  const zones = await registry.listEnabledZones();
  const results: ZoneCronResult[] = [];
  for (const zone of zones) {
    try {
      await dispatchOne(zone);
      results.push({ zoneId: zone.zoneId, ok: true });
    } catch (error) {
      results.push({ zoneId: zone.zoneId, ok: false, error: errorMessage(error) });
    }
  }
  return results;
}

/**
 * Run the daily per-zone loop: collect (per zone) then dispatch, isolating
 * per-zone failures so a failing zone never starves the rest. Returns results.
 */
export async function runDailyCron(
  registry: ZoneRegistryRepository,
  collectOne: (zone: ZoneConfig) => Promise<{
    day: string;
    backfilledDays: string[];
  }>,
  dispatchOne: (
    zone: ZoneConfig,
    result: { day: string; backfilledDays: string[] },
  ) => Promise<unknown>,
): Promise<ZoneCronResult[]> {
  const zones = await registry.listEnabledZones();
  const results: ZoneCronResult[] = [];
  for (const zone of zones) {
    try {
      const result = await collectOne(zone);
      await dispatchOne(zone, result);
      results.push({ zoneId: zone.zoneId, ok: true });
    } catch (error) {
      results.push({ zoneId: zone.zoneId, ok: false, error: errorMessage(error) });
    }
  }
  return results;
}

/** Extract a stable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}