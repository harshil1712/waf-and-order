import { describe, expect, it } from "vitest";

import {
  resolveRollbackAction,
  runGuardedRollback,
} from "../src/cloudflare/rollback.ts";
import type { RulesetRule } from "../src/cloudflare/rulesets.ts";
import { RECOMMENDATION_PHASE } from "../src/shared/recommendation.ts";
import { FakeRulesets } from "./helpers/fake-rulesets.ts";

const ZONE = "zone-abc";
const RULESET_ID = "abcdefabcdefabcdefabcdefabcdefab";
const REC_ID = "R-1042";
const REF = "botguard-R-1042";
const EXPRESSION = "(ip.src.asnum in {16509 14618}) and not cf.client.bot";
const DESCRIPTION = "managed challenge for scraper ASNs";

const TARGET = {
  zoneId: ZONE,
  phase: RECOMMENDATION_PHASE,
  rulesetId: RULESET_ID,
  cloudflareRuleId: "cf-rule-1",
  stableRuleRef: REF,
  action: "managed_challenge" as const,
  expression: EXPRESSION,
  description: DESCRIPTION,
  actionParameters: {},
};

/** A matching rule for the stored approved mutation. */
function matchingRule(id = "cf-rule-1", overrides: Partial<RulesetRule> = {}): RulesetRule {
  return {
    id,
    ref: REF,
    expression: EXPRESSION,
    action: "managed_challenge",
    description: DESCRIPTION,
    action_parameters: {},
    enabled: true,
    ...overrides,
  };
}

/** An unrelated rule that must always be preserved. */
function unrelatedRule(): RulesetRule {
  return {
    id: "cf-unrelated-9",
    ref: "some-other-ref",
    expression: 'http.host eq "example.com"',
    action: "block",
    enabled: true,
  };
}

describe("resolveRollbackAction (pure read-before-delete policy)", () => {
  it("resolves to DELETE the authoritative rule when it matches the stored mutation", () => {
    const result = resolveRollbackAction({ rules: [matchingRule()] }, TARGET);
    expect(result.outcome).toBe("deleted");
    expect(result.resolvedRuleId).toBe("cf-rule-1");
  });

  it("aborts for operator review when the authoritative rule payload has drifted", () => {
    const drifted = matchingRule("cf-rule-1", { expression: 'http.host eq "changed"' });
    const result = resolveRollbackAction({ rules: [drifted] }, TARGET);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toMatch(/drifted from the stored approved mutation/);
    expect(result.resolvedRuleId).toBe("cf-rule-1");
  });

  it("aborts for operator review when the authoritative rule is explicitly disabled", () => {
    const disabled = matchingRule("cf-rule-1", { enabled: false });
    const result = resolveRollbackAction({ rules: [disabled] }, TARGET);
    expect(result.outcome).toBe("aborted");
  });

  it("aborts (no fallback) when the authoritative id exists but drifted, even if a stable-ref match exists", () => {
    // Authoritative id present and found with drifted payload. Policy A applies:
    // we must NOT fall back to the stable-ref rule or another id.
    const rules = [
      matchingRule("cf-rule-1", { expression: 'http.host eq "drifted"' }),
      matchingRule("cf-rule-2"),
    ];
    const result = resolveRollbackAction({ rules }, TARGET);
    expect(result.outcome).toBe("aborted");
    expect(result.resolvedRuleId).toBe("cf-rule-1");
  });

  it("recovers a missing authoritative id via a single matching stable ref", () => {
    // Authoritative id recorded but not found; exactly one stable-ref rule matches.
    const result = resolveRollbackAction({ rules: [matchingRule("cf-rule-2")] }, TARGET);
    expect(result.outcome).toBe("deleted");
    expect(result.resolvedRuleId).toBe("cf-rule-2");
    expect(result.reason).toMatch(/stable-ref recovery/);
  });

  it("confirms absence (idempotent already_absent) when authoritative id missing and no stable ref exists", () => {
    const result = resolveRollbackAction({ rules: [unrelatedRule()] }, TARGET);
    expect(result.outcome).toBe("already_absent");
    expect(result.reason).toMatch(/confirms no .* rule; idempotent/);
  });

  it("aborts on duplicate stable refs when the authoritative id is missing", () => {
    const result = resolveRollbackAction(
      { rules: [matchingRule("cf-1"), matchingRule("cf-2")] },
      { ...TARGET, cloudflareRuleId: undefined },
    );
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toMatch(/duplicate\/conflicting refs/);
  });

  it("recovers an unavailable authoritative id via a single matching stable ref", () => {
    const result = resolveRollbackAction(
      { rules: [matchingRule("cf-2")] },
      { ...TARGET, cloudflareRuleId: undefined },
    );
    expect(result.outcome).toBe("deleted");
    expect(result.resolvedRuleId).toBe("cf-2");
  });

  it("aborts on a stable-ref rule whose payload drifted when id unavailable", () => {
    const result = resolveRollbackAction(
      { rules: [matchingRule("cf-2", { description: "changed" })] },
      { ...TARGET, cloudflareRuleId: undefined },
    );
    expect(result.outcome).toBe("aborted");
  });

  it("aborts on a stable-ref rule that is explicitly disabled when id unavailable", () => {
    const result = resolveRollbackAction(
      { rules: [matchingRule("cf-2", { enabled: false })] },
      { ...TARGET, cloudflareRuleId: undefined },
    );
    expect(result.outcome).toBe("aborted");
  });
});

describe("runGuardedRollback (application-owned service)", () => {
  it("deletes the authoritative rule and verifies absence, preserving unrelated rules", async () => {
    const client = new FakeRulesets();
    client.rules = [unrelatedRule(), matchingRule("cf-rule-1")];
    const result = await runGuardedRollback(client, TARGET);
    expect(result.outcome).toBe("deleted");
    expect(result.verifiedAfter).toBe(true);
    expect(client.deletes).toEqual([{ ruleId: "cf-rule-1" }]);
    // Unrelated rule preserved; only the target rule was removed.
    expect(client.rules.map((r) => r.id)).toEqual(["cf-unrelated-9"]);
  });

  it("recovers a missing authoritative id via stable ref and deletes that rule", async () => {
    const client = new FakeRulesets();
    client.rules = [matchingRule("cf-recovered")];
    const result = await runGuardedRollback(client, { ...TARGET, cloudflareRuleId: undefined });
    expect(result.outcome).toBe("deleted");
    expect(result.resolvedRuleId).toBe("cf-recovered");
    expect(client.deletes).toEqual([{ ruleId: "cf-recovered" }]);
  });

  it("aborts on payload drift without issuing any DELETE", async () => {
    const client = new FakeRulesets();
    client.rules = [matchingRule("cf-rule-1", { expression: 'http.host eq "drifted"' })];
    const result = await runGuardedRollback(client, TARGET);
    expect(result.outcome).toBe("aborted");
    expect(client.deletes).toHaveLength(0);
  });

  it("aborts on duplicate refs without issuing any DELETE", async () => {
    const client = new FakeRulesets();
    client.rules = [matchingRule("cf-1"), matchingRule("cf-2")];
    const result = await runGuardedRollback(client, { ...TARGET, cloudflareRuleId: undefined });
    expect(result.outcome).toBe("aborted");
    expect(client.deletes).toHaveLength(0);
  });

  it("is idempotent: a retried run whose rule is already gone reports already_absent", async () => {
    const client = new FakeRulesets();
    client.rules = [unrelatedRule(), matchingRule("cf-rule-1")];
    const first = await runGuardedRollback(client, TARGET);
    expect(first.outcome).toBe("deleted");
    // Retry the same rollback on the same client: the rule is already absent.
    const second = await runGuardedRollback(client, TARGET);
    expect(second.outcome).toBe("already_absent");
    expect(client.deletes).toHaveLength(1); // no second DELETE
    expect(client.rules.map((r) => r.id)).toEqual(["cf-unrelated-9"]);
  });

  it("handles an uncertain DELETE failure idempotently on retry", async () => {
    const client = new FakeRulesets();
    client.rules = [matchingRule("cf-rule-1")];
    // Simulate a failed DELETE that left the rule in place.
    client.deleteFailures = 1;
    await expect(runGuardedRollback(client, TARGET)).rejects.toThrow(/DELETE rule failed/);
    // On retry the rule still matches and is deleted.
    client.deleteFailures = 0;
    const result = await runGuardedRollback(client, TARGET);
    expect(result.outcome).toBe("deleted");
    expect(client.rules).toHaveLength(0);
  });

  it("preserves unrelated intervening rules across a successful rollback", async () => {
    const client = new FakeRulesets();
    client.rules = [unrelatedRule(), matchingRule("cf-rule-1"), unrelatedRule()];
    const result = await runGuardedRollback(client, TARGET);
    expect(result.outcome).toBe("deleted");
    expect(client.rules.map((r) => r.id)).toEqual(["cf-unrelated-9", "cf-unrelated-9"]);
  });

  it("aborts when the post-delete GET still shows the rule (unverified delete)", async () => {
    const client = new FakeRulesets();
    client.rules = [matchingRule("cf-rule-1")];
    // Simulate a DELETE that reports success but does not actually remove the rule.
    const origDelete = client.deleteRule.bind(client);
    client.deleteRule = async (z, r, id) => {
      await origDelete(z, r, id);
      client.rules = [...client.rules, matchingRule(id)]; // rule reappears
      return {
        id: RULESET_ID,
        name: "x",
        phase: RECOMMENDATION_PHASE,
        version: "2",
        rules: [...client.rules],
      };
    };
    const result = await runGuardedRollback(client, TARGET);
    expect(result.outcome).toBe("aborted");
    expect(result.reason).toMatch(/still shows rule/);
  });
});