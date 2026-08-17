/**
 * Zone-agent approval state machine.
 *
 * The email handler validates the bearer token and dispatches a signal; it
 * never consumes the token. The zone agent consumes `approvalTokenId` and
 * transitions the recommendation from `pending_approval` to `approved` in ONE
 * serialized persisted-state update. This module is a pure, testable reducer:
 * given the current state and an approval intent, it returns the next state or
 * a no-op. Duplicate or retried deliveries converge because the first valid
 * transition wins and later deliveries observe the token already consumed or
 * the recommendation no longer pending.
 *
 * No WAF write is performed (guarded WAF application happens in the apply tool).
 */

import type { ApprovalTokenRecord, ApprovedRecord, Recommendation, ZoneAgentState } from "./types.ts";

/** The result of applying an approval intent to the state. */
export interface ApprovalOutcome {
  applied: boolean;
  /** Human/audit reason for the outcome. */
  reason: string;
  /** The consumed token id when applied. */
  approvalTokenId?: string;
  next?: ZoneAgentState;
}

/** The approval intent carried by the verified signal (attributes only). */
export interface ApprovalIntent {
  recommendationId: string;
  approvalTokenId: string;
  /** Inject the "now" to make expiry checks deterministic in tests. */
  now: Date;
  /** Inject the submission id that performed the transition (audit). */
  consumedBy?: string;
}

/** Find a recommendation by id, or undefined. */
export function findRecommendation(
  state: ZoneAgentState,
  recommendationId: string,
): Recommendation | undefined {
  return state.recommendations.find((r) => r.id === recommendationId);
}

/** Whether a recommendation is still awaiting approval. */
function isPendingApproval(r: Recommendation | undefined, now: Date): boolean {
  if (!r) return false;
  if (r.status !== "pending_approval") return false;
  return new Date(r.expiresAt).getTime() > now.getTime();
}

/**
 * Atomic, serialized approval transition. Validates in order:
 *   1. The token record exists and is unconsumed.
 *   2. The token record is bound to this zone and recommendation.
 *   3. The token record has not expired.
 *   4. The recommendation is present, pending_approval, and unexpired.
 *   5. The token payload matches the record (defense in depth).
 * Then transitions pending_approval → approved, marks the token consumed, and
 * records a simulated approval. Returns a no-op for any invalid or duplicate
 * attempt — the first valid transition wins.
 */
export function applyApprovalTransition(
  state: ZoneAgentState,
  intent: ApprovalIntent,
): ApprovalOutcome {
  const token = state.approvalTokens.find((t) => t.tokenId === intent.approvalTokenId);
  if (!token) {
    return { applied: false, reason: "unknown_approval_token" };
  }
  if (token.consumedAt) {
    return { applied: false, reason: "token_already_consumed" };
  }
  if (token.recommendationId !== intent.recommendationId) {
    return { applied: false, reason: "token_recommendation_mismatch" };
  }
  if (token.zoneId !== state.zoneId) {
    return { applied: false, reason: "token_zone_mismatch" };
  }
  if (new Date(token.expiresAt).getTime() <= intent.now.getTime()) {
    return { applied: false, reason: "token_expired" };
  }

  const recommendation = findRecommendation(state, intent.recommendationId);
  if (!isPendingApproval(recommendation, intent.now) || !recommendation) {
    return { applied: false, reason: "recommendation_not_pending_approval" };
  }

  // Defense in depth: the recorded token payload must reference the same
  // recommendation and zone it is bound to.
  const payload = JSON.parse(token.payload) as {
    recommendationId: string;
    zoneId: string;
  };
  if (
    payload.recommendationId !== intent.recommendationId ||
    payload.zoneId !== token.zoneId
  ) {
    return { applied: false, reason: "token_payload_mismatch" };
  }

  const recommendationId = intent.recommendationId;
  const approvedAt = intent.now.toISOString();
  const consumedAt = approvedAt;

  const updatedRecommendations = state.recommendations.map((r) =>
    r.id === recommendationId ? { ...r, status: "approved" as const } : r,
  );
  const updatedTokens = state.approvalTokens.map((t) =>
    t.tokenId === intent.approvalTokenId
      ? { ...t, consumedAt, consumedBy: intent.consumedBy }
      : t,
  );

  const approvedRecord: ApprovedRecord = {
    recommendationId,
    mutationId: recommendation.mutationId,
    payloadHash: recommendation.payloadHash,
    approvedAt,
    approvalTokenId: intent.approvalTokenId,
    status: "approved",
  };
  const approvedRecords = [
    ...state.approvedRecords.filter((r) => r.recommendationId !== recommendationId),
    approvedRecord,
  ];

  const next: ZoneAgentState = {
    ...state,
    recommendations: updatedRecommendations,
    approvalTokens: updatedTokens,
    approvedRecords,
  };

  return {
    applied: true,
    reason: "approved",
    approvalTokenId: intent.approvalTokenId,
    next,
  };
}

/** Load the bound token record for a recommendation, if any. */
export function tokenForRecommendation(
  state: ZoneAgentState,
  recommendationId: string,
): ApprovalTokenRecord | undefined {
  return state.approvalTokens.find(
    (t) => t.recommendationId === recommendationId && !t.consumedAt,
  );
}