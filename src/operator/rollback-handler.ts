/**
 * Deterministic authorized-rollback handler for the shared agent.
 *
 * Called from the control-plane agent's `useAgentStart` when it receives a
 * `waf.rollback.authorized` signal (dispatched by the Access-protected operator
 * API after D1 audit). It:
 *
 *   1. Loads the zone's trusted slice and D1 config (zone/ruleset/phase).
 *   2. Requires the recommendation to be in a rollbackable lifecycle state.
 *   3. CROSS-CHECKS the stored recommendation's zoneId/rulesetId/phase against
 *      the input zone and the D1 config BEFORE any DELETE — a contaminated or
 *      cross-zone slice fails closed with no mutation.
 *   4. Builds the {@link RollbackTarget} from the STORED approved mutation and
 *      applied-rule record (never from the signal or the model).
 *   5. Runs the guarded single-rule DELETE, distinguishing:
 *        - `deleted` — a DELETE was performed and confirmed;
 *        - `already_absent` — absence was confirmed (crash/retry convergence);
 *        - `aborted` — drift / duplicate refs; operator review required.
 *   6. Optionally records an outcome audit row (post-guard) when `recordOutcome`
 *      is provided.
 *
 * STATE TRANSITION POLICY: the caller must mark the recommendation + applied
 * rule `rolled_back` ONLY after `deleted` OR confirmed `already_absent` — never
 * after `aborted`, a missing credential, an unknown recommendation, a
 * non-rollbackable status, or a contaminated/cross-zone slice.
 *
 * FAILS CLOSED: when the WAF write credential is absent, the recommendation is
 * not rollbackable, the zone is unknown/disabled, or the slice is contaminated,
 * NO delete is performed and a non-destructive `not_performed` result is
 * returned. The caller must never pretend a rollback executed when it did not.
 */

import type { ZoneConfig } from "../registry/zone-registry.ts";
import type { ZoneAgentState } from "../shared/types.ts";
import { runGuardedRollback, type RollbackTarget } from "../cloudflare/rollback.ts";
import type { RulesetsClient } from "../cloudflare/rulesets.ts";
import { markRolledBack, ROLLBACKABLE_STATUSES } from "../shared/monitor-state.ts";
import { findRecommendation } from "../shared/approval-state.ts";

export interface AuthorizedRollbackInput {
  zoneId: string;
  recommendationId: string;
  /** D1-resolved zone config (authoritative zone/ruleset/phase). */
  config: ZoneConfig;
  /** The zone's current trusted slice. */
  slice: ZoneAgentState;
  /** The application-owned Rulesets client (bound to WAF_WRITE_TOKEN), or null. */
  client: RulesetsClient | null;
  /** Inject a clock for deterministic tests. */
  now?: Date;
  /**
   * Optional post-guard outcome audit (D1) so the initial "requested" row is
   * followed by a factual execution outcome row. Injected by the agent.
   */
  recordOutcome?: (outcome: {
    outcome: "deleted" | "already_absent" | "aborted" | "not_performed";
    reason: string;
    resolvedRuleId?: string;
  }) => Promise<void>;
}

/** A guarded-rollback outcome. */
export type AuthorizedRollbackResult =
  | { outcome: "deleted"; resolvedRuleId: string; verifiedAfter?: boolean }
  | { outcome: "already_absent"; resolvedRuleId?: string }
  | { outcome: "aborted"; reason: string }
  | { outcome: "not_performed"; reason: string };

/** Whether a result authorizes the `rolled_back` state transition. */
export function shouldMarkRolledBack(result: AuthorizedRollbackResult): boolean {
  return result.outcome === "deleted" || result.outcome === "already_absent";
}

/**
 * Build a {@link RollbackTarget} from the stored recommendation + applied rule,
 * using the D1-resolved ruleset/phase. Returns null when the stored mutation
 * cannot be reconstructed from trusted state (never guessed).
 */
export function buildRollbackTarget(
  slice: ZoneAgentState,
  config: ZoneConfig,
  recommendationId: string,
): RollbackTarget | null {
  const rec = findRecommendation(slice, recommendationId);
  if (!rec) return null;
  const applied = slice.appliedRules.find(
    (a) => a.recommendationId === recommendationId,
  );
  // The exact mutation payload is authoritative only in the stored
  // recommendation; without it we cannot reconstruct the rule.
  if (!rec.expression) return null;
  return {
    zoneId: rec.zoneId,
    rulesetId: config.rulesetId,
    phase: config.rulesetPhase,
    cloudflareRuleId: applied?.cloudflareRuleId,
    stableRuleRef: rec.stableRuleRef,
    action: rec.action,
    expression: rec.expression,
    description: rec.description,
    actionParameters: {},
  };
}

/**
 * Cross-check the stored recommendation against the input zone and the D1
 * config (zoneId/rulesetId/phase). Any mismatch indicates a contaminated or
 * cross-zone slice and must fail closed BEFORE a DELETE.
 */
export function crossCheckRollbackTarget(
  slice: ZoneAgentState,
  zoneId: string,
  config: ZoneConfig,
  recommendationId: string,
): { ok: true } | { ok: false; reason: string } {
  const rec = findRecommendation(slice, recommendationId);
  if (!rec) return { ok: false, reason: "unknown_recommendation" };
  const mismatches: string[] = [];
  if (rec.zoneId !== zoneId) mismatches.push("rec.zoneId != input zoneId");
  if (rec.zoneId !== config.zoneId) mismatches.push("rec.zoneId != D1 zoneId");
  if (rec.rulesetId !== config.rulesetId) mismatches.push("rec.rulesetId != D1 rulesetId");
  if (rec.phase !== config.rulesetPhase) mismatches.push("rec.phase != D1 rulesetPhase");
  if (mismatches.length > 0) {
    return { ok: false, reason: `contaminated_zone:${mismatches.join(";")}` };
  }
  return { ok: true };
}

/**
 * Execute an authorized rollback against trusted state + D1 + the guarded
 * delete. Returns a distinct outcome (deleted / already_absent / aborted /
 * not_performed). The caller decides the state transition via
 * {@link shouldMarkRolledBack}.
 */
export async function runAuthorizedRollback(
  input: AuthorizedRollbackInput,
): Promise<AuthorizedRollbackResult> {
  if (!input.client) {
    return { outcome: "not_performed", reason: "credential_absent" };
  }
  if (!input.config.enabled) {
    return { outcome: "not_performed", reason: "unknown_or_disabled_zone" };
  }
  const rec = findRecommendation(input.slice, input.recommendationId);
  if (!rec) {
    return { outcome: "not_performed", reason: "unknown_recommendation" };
  }
  if (!ROLLBACKABLE_STATUSES.has(rec.status)) {
    return { outcome: "not_performed", reason: "not_rollbackable" };
  }
  // Cross-check zone/ruleset/phase BEFORE any DELETE. Fails closed on a
  // contaminated/cross-zone slice.
  const cross = crossCheckRollbackTarget(
    input.slice,
    input.zoneId,
    input.config,
    input.recommendationId,
  );
  if (!cross.ok) {
    return { outcome: "not_performed", reason: cross.reason };
  }
  const target = buildRollbackTarget(input.slice, input.config, input.recommendationId);
  if (!target) {
    return { outcome: "not_performed", reason: "cannot_reconstruct" };
  }
  const result = await runGuardedRollback(input.client, target);

  let final: AuthorizedRollbackResult;
  if (result.outcome === "deleted" && result.resolvedRuleId) {
    final = { outcome: "deleted", resolvedRuleId: result.resolvedRuleId, verifiedAfter: result.verifiedAfter };
  } else if (result.outcome === "already_absent") {
    final = { outcome: "already_absent", resolvedRuleId: result.resolvedRuleId };
  } else {
    final = { outcome: "aborted", reason: result.reason };
  }

  // Post-guard outcome audit (best-effort, injected by the agent).
  if (input.recordOutcome) {
    await input.recordOutcome({
      outcome: final.outcome,
      reason: final.outcome === "aborted" ? final.reason : "",
      resolvedRuleId: final.outcome === "deleted" ? final.resolvedRuleId : undefined,
    });
  }
  return final;
}
