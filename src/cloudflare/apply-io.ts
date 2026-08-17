/**
 * Read-before-write reconciliation and read-after-write verification for the
 * guarded apply tool.
 *
 * The single-rule POST is at-least-once at the failure boundary. To make it
 * idempotent, we always GET the ruleset BEFORE deciding to POST:
 *
 *   - If exactly one rule already exists with the same stable rule reference
 *     and the same recomputed payload hash, we adopt its id as recovery from an
 *     earlier uncertain outcome (no duplicate is created).
 *   - If more than one rule carries the reference, or one exists with a
 *     different payload, we ABORT (conflict / duplicate reference).
 *   - Only when no matching rule exists do we POST the exact stored rule.
 *
 * After the mutation we GET the rule again and verify it matches the exact
 * payload (read-after-write). We never PUT a whole rules list.
 */

import { payloadHashOf } from "../shared/recommendation.ts";
import { RulesetsApiError, type RulesetsClient, type RulesetRule } from "./rulesets.ts";

/** The exact rule payload the apply tool submits (from trusted state). */
export interface ApplyRulePayload {
  expression: string;
  action: "managed_challenge";
  description: string;
  ref: string;
  action_parameters: Record<string, string>;
}

/** The target context needed to recompute the payload hash for comparison. */
export interface ApplyTarget {
  zoneId: string;
  phase: string;
  rulesetId: string;
}

/** Result of a reconcile-or-create operation. */
export interface ReconcileResult {
  /** Whether a single-rule POST was performed (false = adopted a recovered rule). */
  created: boolean;
  /** The authoritative Cloudflare rule id. */
  cloudflareRuleId: string;
}

/**
 * Whether an API rule is enabled for mutation matching. Absent `enabled`
 * preserves compatibility with API fixtures that omit it (treated as the
 * Cloudflare default `true`); an explicit `false` must never be adopted or
 * verified as a successful mutation.
 */
function ruleEnabledForMutation(apiRule: RulesetRule): boolean {
  return apiRule.enabled !== false;
}

/** Recompute the payload hash of an API rule against the submitted payload. */
function rulePayloadHash(apiRule: RulesetRule, target: ApplyTarget): string {
  return payloadHashOf({
    zoneId: target.zoneId,
    phase: target.phase,
    rulesetId: target.rulesetId,
    action: apiRule.action as "managed_challenge",
    expression: apiRule.expression,
    description: apiRule.description ?? "",
    stableRuleRef: apiRule.ref ?? "",
    actionParameters: (apiRule.action_parameters ?? {}) as Record<string, string>,
  });
}

/** Whether an API rule is an exact match for the submitted payload + ref. */
export function ruleMatchesMutation(
  apiRule: RulesetRule,
  rule: ApplyRulePayload,
  target: ApplyTarget,
): boolean {
  if (apiRule.ref !== rule.ref) return false;
  if (!ruleEnabledForMutation(apiRule)) return false;
  // The expected payload uses the SUBMITTED action_parameters (generic/exact),
  // not a hardcoded empty object. Managed Challenge happens to be empty in
  // production, but the matcher must reject any non-empty submitted params that
  // do not exactly equal the API rule's own action_parameters.
  return rulePayloadHash(apiRule, target) === payloadHashOf({
    zoneId: target.zoneId,
    phase: target.phase,
    rulesetId: target.rulesetId,
    action: rule.action,
    expression: rule.expression,
    description: rule.description,
    stableRuleRef: rule.ref,
    actionParameters: rule.action_parameters ?? {},
  });
}

/**
 * GET the ruleset, reconcile by stable reference, and create the rule only if
 * absent. Aborts on conflicting or duplicate references. Idempotent: a retry
 * after an uncertain POST finds the rule already present and returns it.
 */
export async function reconcileOrCreate(
  client: RulesetsClient,
  target: ApplyTarget,
  rule: ApplyRulePayload,
): Promise<ReconcileResult> {
  const ruleset = await client.getRuleset(target.zoneId, target.rulesetId);
  const withRef = ruleset.rules.filter((r) => r.ref === rule.ref);

  if (withRef.length > 1) {
    throw new RulesetsApiError(
      `duplicate stable rule references (${withRef.length}) for ${rule.ref}; aborting`,
      409,
      null,
    );
  }
  if (withRef.length === 1) {
    const existing = withRef[0];
    if (!ruleMatchesMutation(existing, rule, target)) {
      throw new RulesetsApiError(
        `stable rule reference ${rule.ref} exists with a different payload; aborting`,
        409,
        null,
      );
    }
    return { created: false, cloudflareRuleId: existing.id };
  }

  // Absent: POST exactly this one rule.
  const updated = await client.createRule(target.zoneId, target.rulesetId, rule);
  const created = updated.rules.find((r) => r.ref === rule.ref);
  if (!created) {
    throw new RulesetsApiError(
      `POST succeeded but created rule ${rule.ref} not found in response`,
      500,
      null,
    );
  }
  return { created: true, cloudflareRuleId: created.id };
}

/**
 * Read-after-write verification: GET the ruleset again and confirm the created
 * rule exists with the exact payload.
 */
export async function verifyRuleReadAfterWrite(
  client: RulesetsClient,
  target: ApplyTarget,
  ruleId: string,
  rule: ApplyRulePayload,
): Promise<boolean> {
  const ruleset = await client.getRuleset(target.zoneId, target.rulesetId);
  const found = ruleset.rules.find((r) => r.id === ruleId);
  if (!found) return false;
  return ruleMatchesMutation(found, rule, target);
}