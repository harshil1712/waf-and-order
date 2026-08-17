/**
 * Zone-agent application state machine.
 *
 * Pure, testable reducers for the guarded WAF apply tool. Every transition
 * checks its expected prior state; duplicate deliveries and retried durable
 * executions converge without duplicate mutations. The durable apply tool
 * chains: approved → applying → applied → monitoring, recording the
 * authoritative Cloudflare rule id in `appliedRules`.
 *
 * No live WAF write happens here — these reducers only persist state. The
 * external mutation is performed by the deterministic apply tool through
 * `step.do()` checkpoints (at-least-once, made idempotent by read-before-write
 * recovery against the stable rule reference).
 */

import type { Recommendation, ZoneAgentState } from "./types.ts";
import { findRecommendation } from "./approval-state.ts";

/** The result of applying an application intent to the state. */
export interface ApplyTransitionOutcome {
  applied: boolean;
  reason: string;
  next?: ZoneAgentState;
  cloudflareRuleId?: string;
}

/** The application intent carried by the apply tool (ids only). */
export interface ApplyIntent {
  recommendationId: string;
  approvalTokenId: string;
  /** Inject the "now" so expiry checks are deterministic in tests. */
  now: Date;
}

/** Whether a status is one of the "actively applied" lifecycle states. */
function isActiveApplicationStatus(status: Recommendation["status"]): boolean {
  return status === "applying" || status === "applied" || status === "monitoring";
}

/**
 * Transition approved → applying. Idempotent: if the recommendation is already
 * applying/applied/monitoring, this is a convergent no-op (applied:true), so a
 * re-executed durable tool does not error. Fails if the recommendation is not
 * approved, expired, or lacks the exact-bound consumed approval for the token.
 */
export function beginApply(
  state: ZoneAgentState,
  intent: ApplyIntent,
): ApplyTransitionOutcome {
  const rec = findRecommendation(state, intent.recommendationId);
  if (!rec) return { applied: false, reason: "unknown_recommendation" };

  // Convergent recovery: already in an applying lifecycle state.
  if (isActiveApplicationStatus(rec.status)) {
    return { applied: true, reason: "already_applying", next: state };
  }
  if (rec.status !== "approved") {
    return { applied: false, reason: `not_approved:${rec.status}` };
  }
  if (new Date(rec.expiresAt).getTime() <= intent.now.getTime()) {
    return { applied: false, reason: "expired" };
  }

  // The approval must be the exact-bound, consumed approval for this token.
  const approved = state.approvedRecords.find(
    (a) =>
      a.recommendationId === intent.recommendationId &&
      a.approvalTokenId === intent.approvalTokenId &&
      a.status === "approved",
  );
  if (!approved) return { applied: false, reason: "no_matching_approved_record" };
  const token = state.approvalTokens.find((t) => t.tokenId === intent.approvalTokenId);
  if (!token || !token.consumedAt) return { applied: false, reason: "token_not_consumed" };
  if (token.recommendationId !== intent.recommendationId || token.zoneId !== state.zoneId) {
    return { applied: false, reason: "token_binding_mismatch" };
  }

  const next: ZoneAgentState = {
    ...state,
    recommendations: state.recommendations.map((r) =>
      r.id === intent.recommendationId ? { ...r, status: "applying" as const } : r,
    ),
  };
  return { applied: true, reason: "began", next };
}

/**
 * Transition applying → applied and record the authoritative Cloudflare rule id.
 * Idempotent: if already applied/monitoring, a convergent no-op.
 */
export function markApplied(
  state: ZoneAgentState,
  intent: ApplyIntent,
  cloudflareRuleId: string,
): ApplyTransitionOutcome {
  const rec = findRecommendation(state, intent.recommendationId);
  if (!rec) return { applied: false, reason: "unknown_recommendation" };

  if (rec.status === "applied" || rec.status === "monitoring") {
    return { applied: true, reason: "already_applied", next: state };
  }
  if (rec.status !== "applying") {
    return { applied: false, reason: `not_applying:${rec.status}` };
  }

  const appliedAt = intent.now.toISOString();
  const next: ZoneAgentState = {
    ...state,
    recommendations: state.recommendations.map((r) =>
      r.id === intent.recommendationId
        ? { ...r, status: "applied" as const, cloudflareRuleId }
        : r,
    ),
    appliedRules: [
      ...state.appliedRules.filter((a) => a.recommendationId !== intent.recommendationId),
      {
        recommendationId: intent.recommendationId,
        cloudflareRuleId,
        mutationId: rec.mutationId,
        payloadHash: rec.payloadHash,
        appliedAt,
        status: "applied" as const,
      },
    ],
  };
  return { applied: true, reason: "applied", cloudflareRuleId, next };
}

/**
 * Transition applied → monitoring. Idempotent: already monitoring is a no-op.
 */
export function markMonitoring(
  state: ZoneAgentState,
  intent: ApplyIntent,
): ApplyTransitionOutcome {
  const rec = findRecommendation(state, intent.recommendationId);
  if (!rec) return { applied: false, reason: "unknown_recommendation" };

  if (rec.status === "monitoring") {
    return { applied: true, reason: "already_monitoring", next: state };
  }
  if (rec.status !== "applied") {
    return { applied: false, reason: `not_applied:${rec.status}` };
  }

  const next: ZoneAgentState = {
    ...state,
    recommendations: state.recommendations.map((r) =>
      r.id === intent.recommendationId ? { ...r, status: "monitoring" as const } : r,
    ),
    recentOutcomes: [
      ...state.recentOutcomes.filter((o) => o.recommendationId !== intent.recommendationId),
      {
        recommendationId: intent.recommendationId,
        status: "monitoring" as const,
        summary: "Applied and entering impact monitoring.",
      },
    ],
  };
  return { applied: true, reason: "monitoring", next };
}