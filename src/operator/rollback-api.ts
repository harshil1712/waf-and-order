/**
 * Operator rollback confirmation API/UI (Access-protected).
 *
 * This is the SEPARATELY AUTHORIZED operator path for rollback. It is mounted
 * behind Cloudflare Access middleware and requires:
 *   - an exact `zoneId` + `recommendationId`;
 *   - an exact confirmation phrase (`ROLLBACK_CONFIRMATION_PHRASE`);
 *   - same-origin validation for browser POSTs (cross-origin rejected);
 *   - an append-only D1 audit row written BEFORE any dispatch.
 *
 * On success it dispatches an internal `waf.rollback.authorized` signal to the
 * shared `control-plane` agent carrying ONLY identifiers + operator identity —
 * never a rule payload, token, or credential. There is NO model-facing rollback
 * tool; the model can never trigger rollback.
 */

import { Hono, type Context } from "hono";

import {
  isRollbackConfirmation,
  ROLLBACK_CONFIRMATION_PHRASE,
} from "../registry/operator-actions.ts";
import type { ZoneRegistryRepository } from "../registry/d1.ts";
import type { VerifiedOperator } from "../access/jwks.ts";

/** The action verb recorded for the operator's initial rollback REQUEST. */
export const ROLLBACK_REQUEST_ACTION = "waf.rollback.requested";

/** Attributes dispatched to the control-plane agent (identifiers only). */
export interface RollbackDispatchAttributes {
  zoneId: string;
  recommendationId: string;
  operatorIdentity?: string;
}

/** The dispatch surface (injected; prod uses Flue dispatch). */
export type RollbackDispatcher = (
  attributes: RollbackDispatchAttributes,
) => Promise<void>;

export interface RollbackApiDeps {
  /** Resolve the D1 zone registry from the request env (lazily). */
  registryFor: (env: CloudflareBindings) => ZoneRegistryRepository;
  /** Dispatch the authorized rollback signal (injected for tests). */
  dispatchRollback: RollbackDispatcher;
  /** Injectable clock for deterministic audit timestamps. */
  now?: () => Date;
}

/** Whether two URL strings share the same origin (scheme + host + port). */
export function sameOrigin(origin: string, requestUrl: string): boolean {
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

/**
 * CSRF Origin policy (hard-coded, no configurable allowlist):
 *   - A request with NO `Origin` header is allowed (non-browser API client; the
 *     Access JWT is still mandatory).
 *   - With an `Origin` header, the origin must be same-origin with the request
 *     URL. Arbitrary cross-origin browser origins are always rejected.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  requestUrl: string,
): boolean {
  if (!origin) return true;
  return sameOrigin(origin, requestUrl);
}

/** Build the Access-protected operator Hono sub-app. */
export function createOperatorApi(deps: RollbackApiDeps): Hono<{ Bindings: CloudflareBindings }> {
  const app = new Hono<{ Bindings: CloudflareBindings }>();
  const clock = deps.now ?? (() => new Date());

  // List enabled zones (read-only).
  app.get("/zones", async (c) => {
    const registry = deps.registryFor(c.env);
    const zones = await registry.listEnabledZones();
    return c.json({
      zones: zones.map((z) => ({
        zoneId: z.zoneId,
        hostname: z.hostname,
        enabled: z.enabled,
      })),
    });
  });

  // Submit an explicit rollback confirmation.
  app.post("/rollback", async (c) => {
    const registry = deps.registryFor(c.env);
    const operator = (
      c as unknown as Context<{ Variables: Record<string, unknown> }>
    ).get("operator") as VerifiedOperator | undefined;

    // Origin validation for browser POSTs (defense against CSRF).
    if (!isAllowedOrigin(c.req.header("Origin"), c.req.url)) {
      return c.json({ error: "origin_not_allowed" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "invalid_json" }, 400);
    }
    const { zoneId, recommendationId, confirmation } = body as {
      zoneId?: string;
      recommendationId?: string;
      confirmation?: string;
    };

    // Exact identifiers + exact confirmation phrase required.
    if (typeof zoneId !== "string" || !zoneId) {
      return c.json({ error: "zoneId_required" }, 400);
    }
    if (typeof recommendationId !== "string" || !recommendationId) {
      return c.json({ error: "recommendationId_required" }, 400);
    }
    if (typeof confirmation !== "string" || !isRollbackConfirmation(confirmation)) {
      return c.json({ error: "confirmation_phrase_required" }, 400);
    }

    // The zone must exist and be enabled in D1 before we accept the rollback.
    const zone = await registry.getEnabledZone(zoneId);
    if (!zone) {
      return c.json({ error: "unknown_or_disabled_zone" }, 404);
    }

    const operatorIdentity = operator?.email ?? "unknown-operator";

    // Append-only audit BEFORE dispatch (identifiers + identity only). The
    // initial row records an authenticated REQUEST, not a successful execution;
    // the agent writes a separate `waf.rollback.outcome` row after the guard.
    await registry.recordOperatorAction({
      zoneId,
      recommendationId,
      action: ROLLBACK_REQUEST_ACTION,
      operatorIdentity,
      confirmationPhrase: confirmation,
      metadata: { origin: c.req.header("Origin") ?? undefined },
      createdAt: clock().toISOString(),
    });

    // Dispatch the internal signal (identifiers/operator only, no secrets).
    await deps.dispatchRollback({
      zoneId,
      recommendationId,
      operatorIdentity,
    });

    return c.json(
      { ok: true, zoneId, recommendationId, action: ROLLBACK_REQUEST_ACTION },
      202,
    );
  });

  return app;
}
