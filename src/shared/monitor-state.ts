/**
 * Monitoring + rollback state reducers.
 *
 * Pure, testable reducers that mutate ONLY the monitoring/rollback lifecycle
 * fields of {@link ZoneAgentState} and never touch the immutable mutation
 * fields of a recommendation. The full impact report and its metrics live in
 * R2 (outcome-storage.ts); state keeps a concise pointer to each checkpoint
 * outcome plus the rollback lifecycle status.
 *
 * The rollback transition chain is:
 *   {applied | monitoring | rollback_recommended} → rolled_back
 *
 * Every transition checks its expected prior state, so duplicate deliveries
 * and retried executions converge (the first valid transition wins). A
 * persisted `rollback_recommended` status (from earlier deployments) remains
 * rollbackable. These reducers only persist state; the external guarded
 * DELETE is an application-owned service (rollback.ts), not a model tool.
 */

import type { MonitoringRecord, ZoneAgentState } from "./types.ts";
import type { Recommendation } from "./recommendation.ts";

/** The result of applying a monitoring intent to the state. */
export interface MonitoringTransitionOutcome {
  applied: boolean;
  reason: string;
  next?: ZoneAgentState;
}

/** Record a checkpoint outcome in state (idempotent, one record per checkpoint). */
export function recordCheckpointOutcome(
  state: ZoneAgentState,
  record: MonitoringRecord,
): MonitoringTransitionOutcome {
  const existing = (state.monitoringRecords ?? []).some(
    (r) => r.recommendationId === record.recommendationId && r.checkpoint === record.checkpoint,
  );
  if (existing) {
    return { applied: true, reason: "already_recorded", next: state };
  }
  const next: ZoneAgentState = {
    ...state,
    monitoringRecords: [...(state.monitoringRecords ?? []), record],
  };
  return { applied: true, reason: "recorded", next };
}

/** The rollback transition intent (ids only, deterministic code). */
export interface RollbackIntent {
  recommendationId: string;
  /** Inject the clock so tests are deterministic. */
  now: Date;
}

/**
 * The lifecycle states from which a recommendation may be rolled back:
 * `applied`, `monitoring`, or `rollback_recommended`. These are the expected
 * prior states for the `rolled_back` transition.
 */
export const ROLLBACKABLE_STATUSES = new Set([
  "applied",
  "monitoring",
  "rollback_recommended",
]);

/**
 * Transition {applied | monitoring | rollback_recommended} → rolled_back.
 * Idempotent: already `rolled_back` is a convergent no-op. Only the expected
 * prior states listed in {@link ROLLBACKABLE_STATUSES} may transition, so a
 * stale/replayed delivery converges and never corrupts an unrelated state. The
 * recommendation and its matching `appliedRules` record are both marked
 * `rolled_back`.
 */
export function markRolledBack(
  state: ZoneAgentState,
  intent: RollbackIntent,
): MonitoringTransitionOutcome {
  const rec = findRecommendation(state, intent.recommendationId);
  if (!rec) return { applied: false, reason: "unknown_recommendation" };
  if (rec.status === "rolled_back") {
    return { applied: true, reason: "already_rolled_back", next: state };
  }
  if (!ROLLBACKABLE_STATUSES.has(rec.status)) {
    return { applied: false, reason: `not_rollbackable:${rec.status}` };
  }
  const updatedAt = intent.now.toISOString();
  const next: ZoneAgentState = {
    ...state,
    recommendations: state.recommendations.map((r) =>
      r.id === intent.recommendationId ? { ...r, status: "rolled_back" as const } : r,
    ),
    appliedRules: state.appliedRules.map((a) =>
      a.recommendationId === intent.recommendationId ? { ...a, status: "rolled_back" as const } : a,
    ),
    rollbackOutcomes: [
      ...(state.rollbackOutcomes ?? []).filter((o) => o.recommendationId !== intent.recommendationId),
      { recommendationId: intent.recommendationId, status: "rolled_back" as const, summary: "Rule removed via guarded rollback.", updatedAt },
    ],
    recentOutcomes: [
      ...state.recentOutcomes.filter((o) => o.recommendationId !== intent.recommendationId),
      { recommendationId: intent.recommendationId, status: "rolled_back" as const, summary: "Rolled back." },
    ],
  };
  return { applied: true, reason: "rolled_back", next };
}

/** Find a recommendation by id, or undefined. */
function findRecommendation(state: ZoneAgentState, recommendationId: string): Recommendation | undefined {
  return state.recommendations.find((r) => r.id === recommendationId);
}
