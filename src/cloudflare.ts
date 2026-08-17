/**
 * Source-root Cloudflare entry (shared
 * control plane; Flue cloudflare-target guide "Extending cloudflare.ts
 * Entrypoint").
 *
 * This file may not define a default `fetch` handler (app.ts owns HTTP). Its
 * default export contributes the non-HTTP Worker handlers — the daily, weekly,
 * and monitoring Cron Triggers and the Email Routing handler.
 *
 * Every scheduled handler enumerates the ENABLED zones from D1 and
 * dispatches a per-zone signal to the single SHARED `control-plane` agent using
 * a per-zone Flue `idempotencyKey` so retried platform deliveries converge on
 * one submission. There is no per-zone isolation in
 * the MVP; the shared agent keys its state by `zoneId`.
 *
 * Cron triggers (UTC) are declared in wrangler.jsonc:
 *   - `0 4 * * *`  daily collection of the previous completed day + backfill
 *   - `0 5 * * 1`  weekly report (Monday)
 *   - `0 6 * * *`  monitoring check (after daily collection)
 *
 * The Email Routing handler (`email`) composes the pure inbound approval
 * engine with the scheduled handlers.
 */

import { dispatch } from "@flue/runtime";

import { ZoneBotAnalyst } from "./agents/zone-bot-analyst.ts";
import { runDailyCollection } from "./analytics/orchestration.ts";
import { yesterdayIso } from "./shared/dates.ts";
import { handleInboundEmail } from "./email/handler.ts";
import { CONTROL_PLANE_CONVERSATION_ID } from "./shared/control-plane.ts";
import { ZoneRegistryRepository } from "./registry/d1.ts";
import {
  runDailyCron,
  runDispatchCron,
} from "./cloudflare/cron-signals.ts";

/** The daily collection cron pattern (04:00 UTC). */
export const DAILY_CRON = "0 4 * * *";
/** The weekly report cron pattern (Monday 05:00 UTC). */
export const WEEKLY_CRON = "0 5 * * 1";
/** The monitoring check cron pattern (06:00 UTC, after daily collection). */
export const MONITORING_CRON = "0 6 * * *";

/**
 * The scheduled + email handlers. `controller.cron` identifies which pattern
 * fired; a Worker has a single `scheduled` handler (Flue schedules guide). The
 * `env` is the generated `CloudflareBindings` — no hand-written Env is needed.
 */
export default {
  async scheduled(controller: ScheduledController, env: CloudflareBindings): Promise<void> {
    if (controller.cron === DAILY_CRON) {
      await runDailySignals(env);
    } else if (controller.cron === WEEKLY_CRON) {
      await runWeeklySignals(env);
    } else if (controller.cron === MONITORING_CRON) {
      await runMonitoringSignals(env);
    }
  },
  async email(message: ForwardableEmailMessage, env: CloudflareBindings): Promise<void> {
    await handleInboundEmail(message, env, {
      dispatchFn: (request) => dispatch(ZoneBotAnalyst, request),
    });
  },
};

/** Build the zone registry from the D1 binding (fails closed if unbound). */
export function registryFromEnv(env: CloudflareBindings): ZoneRegistryRepository {
  return new ZoneRegistryRepository(env.DB);
}

/** Daily: collect yesterday per enabled zone, then signal completion per zone. */
async function runDailySignals(env: CloudflareBindings): Promise<void> {
  const registry = registryFromEnv(env);
  const results = await runDailyCron(
    registry,
    (zone) =>
      runDailyCollection({ BOT_TRAFFIC_ANALYTICS: env.BOT_TRAFFIC_ANALYTICS }, zone),
    (zone, result) =>
      dispatch(ZoneBotAnalyst, {
        id: CONTROL_PLANE_CONVERSATION_ID,
        idempotencyKey: `collection:${zone.zoneId}:${result.day}`,
        message: {
          kind: "signal",
          type: "collection.completed",
          body: `Daily analytics rollup for ${result.day} (${zone.hostname}) was collected and written to R2.`,
          attributes: {
            day: result.day,
            zoneId: zone.zoneId,
            backfilledDays: result.backfilledDays.join(","),
          },
        },
      }),
  );
  reportCronFailures("daily", results);
}

/**
 * Weekly: signal the shared agent to generate and send the weekly report for
 * each enabled zone over the last seven COMPLETED UTC days, ending on the
 * previous day (never today, whose rollup does not yet exist).
 */
async function runWeeklySignals(env: CloudflareBindings): Promise<void> {
  const registry = registryFromEnv(env);
  const endDay = yesterdayIso();
  const results = await runDispatchCron(registry, (zone) =>
    dispatch(ZoneBotAnalyst, {
      id: CONTROL_PLANE_CONVERSATION_ID,
      idempotencyKey: `weekly-report:${zone.zoneId}:${endDay}`,
      message: {
        kind: "signal",
        type: "weekly.report.requested",
        body: "Generate and send the weekly bot-traffic report for the last seven completed days.",
        attributes: { endDay, zoneId: zone.zoneId },
      },
    }),
  );
  reportCronFailures("weekly", results);
}

/**
 * Monitoring: signal the shared agent to run due post-application impact checks
 * for each enabled zone. Runs after daily collection so the most recent rollup
 * is available. The agent's monitor_recommendation tool computes the 24h/7d
 * impact reports deterministically from R2 and sends them through the report
 * sender. The signal is idempotent per zone per day. It does NOT request any
 * rollback — rollback is an application-owned, separately authorized operator
 * action.
 */
async function runMonitoringSignals(env: CloudflareBindings): Promise<void> {
  const registry = registryFromEnv(env);
  const endDay = yesterdayIso();
  const results = await runDispatchCron(registry, (zone) =>
    dispatch(ZoneBotAnalyst, {
      id: CONTROL_PLANE_CONVERSATION_ID,
      idempotencyKey: `monitoring:${zone.zoneId}:${endDay}`,
      message: {
        kind: "signal",
        type: "monitoring.check.due",
        body: "Run due post-application impact checks. Use monitor_recommendation for each applied recommendation whose 24h or 7d checkpoint is due.",
        attributes: { endDay, zoneId: zone.zoneId },
      },
    }),
  );
  reportCronFailures("monitoring", results);
}

/** Log per-zone cron failures without rethrowing (one zone never starves others). */
function reportCronFailures(
  kind: string,
  results: { zoneId: string; ok: boolean; error?: string }[],
): void {
  for (const result of results) {
    if (!result.ok) {
      console.error(`[cron:${kind}] zone ${result.zoneId} failed: ${result.error}`);
    }
  }
}