/**
 * Guarded rollback service.
 *
 * CRITICAL AUTHORIZATION BOUNDARY: this is an APPLICATION-OWNED service, NOT a
 * model-mounted tool. The MVP does NOT automatically roll back solely because
 * the model requests it. Accordingly, this module exposes
 * no tool for the agent and no DELETE through MCP. It is a deterministic
 * function intended to be invoked by a SEPARATELY AUTHORIZED operator path
 * (e.g. an authenticated operator call that independently confirms the rollback
 * intent). An operator path must supply the stored approved mutation from
 * trusted persistent state; the service never trusts model-supplied rule ids,
 * zones, or payloads.
 *
 * DELETE surface: single-rule DELETE only (`deleteRule`), never a whole-ruleset
 * PUT, so unrelated/intervening rules are always preserved.
 *
 * Read-before-delete resolution (documented policy):
 *
 *   A. Authoritative id present AND the rule is found in the ruleset:
 *        - If its payload matches the stored approved mutation exactly
 *          (action, expression, description, ref, action_parameters, and the
 *          enabled expectation), resolve to DELETE that id.
 *        - If its payload has DRIFTED, ABORT for operator review. We do NOT
 *          fall back to the stable ref or any other rule.
 *   B. Authoritative id present but the rule is NOT found in the ruleset:
 *        - AMBIGUOUS missing authoritative id. Not treated as safe on its own.
 *        - Recover via the stable ref: if exactly one rule with the stable ref
 *          exists AND matches the payload, resolve to DELETE that id (the
 *          recorded id drifted but the rule is identified unambiguously). If
 *          zero rules with the ref exist, absence is confirmed → already_absent
 *          (idempotent). If more than one rule carries the ref, ABORT
 *          (duplicate/conflicting refs).
 *   C. Authoritative id UNAVAILABLE (not recorded):
 *        - Locate by stable ref. Exactly one matching rule → DELETE it. Zero →
 *          stable-ref recovery confirms absence → already_absent. More than one
 *          → ABORT (duplicate refs).
 *
 * Idempotency: DELETE is performed only after resolution confirms the exact
 * rule; a retried run that already deleted the rule finds absence confirmed by
 * stable-ref recovery and reports already_absent rather than erroring.
 */

import {
  ruleMatchesMutation,
  type ApplyRulePayload,
  type ApplyTarget,
} from "./apply-io.ts";
import type { RulesetsClient, RulesetRule } from "./rulesets.ts";

/** The stored approved mutation the rollback verifies against. */
export interface RollbackTarget extends ApplyTarget {
  /** Authoritative Cloudflare rule id; may be unavailable (undefined). */
  cloudflareRuleId?: string;
  /** Recovery aid: never the primary mutation key. */
  stableRuleRef: string;
  action: "managed_challenge";
  expression: string;
  description: string;
  actionParameters: Record<string, string>;
}

/** The outcome of a guarded rollback. */
export interface RollbackResult {
  outcome: "deleted" | "already_absent" | "aborted";
  reason: string;
  /** The resolved rule id that was (or would have been) deleted. */
  resolvedRuleId?: string;
  /** True when a DELETE was performed and a follow-up GET confirmed absence. */
  verifiedAfter?: boolean;
}

/** The rule's stored payload as the apply-io matcher expects it. */
function toRulePayload(target: RollbackTarget): ApplyRulePayload {
  return {
    expression: target.expression,
    action: target.action,
    description: target.description,
    ref: target.stableRuleRef,
    action_parameters: target.actionParameters,
  };
}

/** Whether a rule matches the stored approved mutation exactly. */
function matchesStored(rule: RulesetRule, target: RollbackTarget): boolean {
  return ruleMatchesMutation(rule, toRulePayload(target), target);
}

/** A rule that is explicitly disabled must never be deleted as "ours". */
function isEnabledForRollback(rule: RulesetRule): boolean {
  return rule.enabled !== false;
}

/**
 * Pure read-before-delete resolution. Decides, from the current ruleset, which
 * rule to delete, that the rule is already absent, or that rollback must abort.
 * No IO — fully unit-testable.
 */
export function resolveRollbackAction(
  ruleset: { rules: RulesetRule[] },
  target: RollbackTarget,
): RollbackResult {
  const byId = target.cloudflareRuleId
    ? ruleset.rules.find((r) => r.id === target.cloudflareRuleId)
    : undefined;
  const byRef = ruleset.rules.filter((r) => r.ref === target.stableRuleRef);

  // Policy A: authoritative id present and found.
  if (byId) {
    if (!matchesStored(byId, target) || !isEnabledForRollback(byId)) {
      return {
        outcome: "aborted",
        reason: `authoritative rule ${byId.id} payload has drifted from the stored approved mutation; aborting for operator review`,
        resolvedRuleId: byId.id,
      };
    }
    return { outcome: "deleted", reason: `authoritative rule ${byId.id} matches the stored mutation`, resolvedRuleId: byId.id };
  }

  // Policy B: authoritative id present but not found — AMBIGUOUS.
  if (target.cloudflareRuleId) {
    if (byRef.length > 1) {
      return {
        outcome: "aborted",
        reason: `authoritative rule ${target.cloudflareRuleId} missing and ${byRef.length} rules carry the stable ref ${target.stableRuleRef}; aborting for operator review`,
      };
    }
    if (byRef.length === 1) {
      if (!matchesStored(byRef[0], target) || !isEnabledForRollback(byRef[0])) {
        return {
          outcome: "aborted",
          reason: `stable-ref rule ${byRef[0].id} payload has drifted from the stored approved mutation; aborting for operator review`,
          resolvedRuleId: byRef[0].id,
        };
      }
      return { outcome: "deleted", reason: `authoritative id missing; stable-ref recovery located matching rule ${byRef[0].id}`, resolvedRuleId: byRef[0].id };
    }
    // Zero by-ref: stable-ref recovery confirms absence of the authoritative rule.
    return { outcome: "already_absent", reason: `authoritative rule ${target.cloudflareRuleId} absent and stable-ref recovery confirms no ${target.stableRuleRef} rule; idempotent` };
  }

  // Policy C: authoritative id unavailable — locate by stable ref.
  if (byRef.length > 1) {
    return {
      outcome: "aborted",
      reason: `${byRef.length} rules carry the stable ref ${target.stableRuleRef}; aborting for operator review (duplicate/conflicting refs)`,
    };
  }
  if (byRef.length === 1) {
    if (!matchesStored(byRef[0], target) || !isEnabledForRollback(byRef[0])) {
      return {
        outcome: "aborted",
        reason: `stable-ref rule ${byRef[0].id} payload has drifted from the stored approved mutation; aborting for operator review`,
        resolvedRuleId: byRef[0].id,
      };
    }
    return { outcome: "deleted", reason: `stable-ref recovery located matching rule ${byRef[0].id}`, resolvedRuleId: byRef[0].id };
  }
  return { outcome: "already_absent", reason: `no rule with stable ref ${target.stableRuleRef} exists; absence confirmed` };
}

/**
 * Run the guarded rollback against a live ruleset. Resolution is pure
 * (resolveRollbackAction); DELETE is a single-rule delete; a follow-up GET
 * verifies the resolved id (and ref) is absent. Unrelated/intervening rules are
 * untouched. This is the application-owned service an authorized operator path
 * calls — never a model tool.
 */
export async function runGuardedRollback(
  client: RulesetsClient,
  target: RollbackTarget,
): Promise<RollbackResult> {
  const ruleset = await client.getRuleset(target.zoneId, target.rulesetId);
  const resolution = resolveRollbackAction(ruleset, target);

  if (resolution.outcome !== "deleted" || !resolution.resolvedRuleId) {
    return resolution;
  }

  await client.deleteRule(target.zoneId, target.rulesetId, resolution.resolvedRuleId);

  const after = await client.getRuleset(target.zoneId, target.rulesetId);
  const idGone = !after.rules.some((r) => r.id === resolution.resolvedRuleId);
  const refGone = !after.rules.some((r) => r.ref === target.stableRuleRef);
  if (!idGone || !refGone) {
    return {
      outcome: "aborted",
      reason: `DELETE reported success but post-delete GET still shows rule ${resolution.resolvedRuleId} or ref ${target.stableRuleRef}; aborting for operator review`,
      resolvedRuleId: resolution.resolvedRuleId,
    };
  }

  return {
    outcome: "deleted",
    reason: `deleted rule ${resolution.resolvedRuleId}; post-delete GET confirms absence`,
    resolvedRuleId: resolution.resolvedRuleId,
    verifiedAfter: true,
  };
}