/**
 * Source-root Email Routing handler glue.
 *
 * Composed into `src/cloudflare.ts` alongside the existing scheduled handler.
 * This glue owns the Worker I/O — buffering `message.raw` exactly once,
 * resolving the target zone from the token + D1 registry, delegating
 * to the pure {@link decideInboundApproval} engine, rejecting unverifiable
 * mail, and dispatching a verified signal to the SHARED `control-plane` agent.
 * It never consumes or marks the token and never sends the
 * token or MIME body into model context.
 *
 * There is no global target-zone authorization variable. The handler
 * extracts the token's zone binding from the envelope recipient, loads that
 * zone's D1 row (must be enabled), and uses its allowed envelope senders. A
 * token bound to an unknown or disabled zone is rejected.
 */

import { decideInboundApproval } from "./inbound.ts";
import { extractTokenFromAddress } from "../shared/approval-token.ts";
import { CONTROL_PLANE_CONVERSATION_ID } from "../shared/control-plane.ts";
import { ZoneRegistryRepository } from "../registry/d1.ts";

/** A Flue dispatch request (id + idempotencyKey + message). */
export interface InboundDispatchRequest {
  id: string;
  idempotencyKey: string;
  message: {
    kind: "signal";
    type: string;
    body: string;
    attributes: Record<string, string>;
  };
}

/** A dispatch surface the caller binds to the shared control-plane agent. */
export type InboundDispatcher = (request: InboundDispatchRequest) => Promise<unknown>;

/** Reject the inbound message with a permanent SMTP error. */
function reject(message: ForwardableEmailMessage, reason: string): void {
  // Best-effort: some paths (tests) do not expose setReject.
  try {
    message.setReject(reason);
  } catch {
    /* message already rejected or not rejectable */
  }
}

/**
 * The `email()` handler. Buffers raw once, resolves the target zone from the
 * token + D1, runs the pure decision engine, and dispatches a verified approval
 * signal (or rejects). The signing secret is read from
 * `process.env.APPROVAL_TOKEN_SECRET` (a Worker secret, set via
 * `wrangler secret put`); it is never a wrangler var. Fails closed when unset.
 *
 * `dispatchFn` and `registry` are injectable for tests; production defaults to
 * Flue dispatch and the D1 binding.
 */
export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: CloudflareBindings,
  options: {
    registry?: ZoneRegistryRepository;
    dispatchFn?: InboundDispatcher;
  } = {},
): Promise<void> {
  const registry = options.registry ?? new ZoneRegistryRepository(env.DB);
  const dispatchFn = options.dispatchFn;
  const secret = process.env.APPROVAL_TOKEN_SECRET;
  if (!secret) {
    reject(message, "approval verification is not configured");
    return;
  }

  // Resolve the zone from the token's binding (no global TARGET zone).
  const tokenResult = await extractTokenFromAddress(
    message.to,
    secret,
  ).catch(() => ({ ok: false as const, error: "invalid_token" as const }));
  if (!tokenResult.ok || !tokenResult.payload) {
    reject(message, "invalid_token");
    return;
  }
  const zoneId = tokenResult.payload.zoneId;
  const zone = await registry.getEnabledZone(zoneId);
  if (!zone) {
    reject(message, "unknown_or_disabled_zone");
    return;
  }

  // Buffer `message.raw` once.
  let raw: string;
  try {
    raw = await new Response(message.raw).text();
  } catch {
    reject(message, "unable to read message");
    return;
  }

  const decision = await decideInboundApproval(
    { from: message.from, to: message.to },
    raw,
    {
      zoneId,
      secret,
      allowedSenders: zone.allowedEnvelopeSenders,
      envelopeHeaders: message.headers,
    },
  );

  if (!decision.ok) {
    reject(message, decision.reason);
    return;
  }

  if (!dispatchFn) {
    reject(message, "no_control_plane_dispatcher");
    return;
  }

  // Dispatch a verified signal to the SHARED control-plane conversation. The
  // body and attributes carry ONLY the recommendation id, token id, and zone id
  // — never the token or the MIME body.
  await dispatchFn({
    id: CONTROL_PLANE_CONVERSATION_ID,
    idempotencyKey: decision.dispatch.idempotencyKey,
    message: {
      kind: "signal",
      type: "waf.recommendation.approved",
      body: "An authorized approval was received.",
      attributes: {
        recommendationId: decision.dispatch.recommendationId,
        approvalTokenId: decision.dispatch.approvalTokenId,
        zoneId,
      },
    },
  });
}
