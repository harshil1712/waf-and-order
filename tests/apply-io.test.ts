import { describe, expect, it } from "vitest";

import { createRulesetsClient, RulesetsApiError, type RulesetsClient } from "../src/cloudflare/rulesets.ts";
import {
  reconcileOrCreate,
  verifyRuleReadAfterWrite,
  ruleMatchesMutation,
} from "../src/cloudflare/apply-io.ts";
import { RECOMMENDATION_PHASE } from "../src/shared/recommendation.ts";
import { FakeRulesets } from "./helpers/fake-rulesets.ts";

const ZONE = "zone-abc";
const RULESET_ID = "abcdefabcdefabcdefabcdefabcdefab";
const TARGET = { zoneId: ZONE, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID };

const RULE = {
  expression: "(ip.src.asnum in {16509 14618}) and not cf.client.bot",
  action: "managed_challenge" as const,
  description: "desc",
  ref: "botguard-R-1042",
  action_parameters: {},
};

describe("createRulesetsClient (application-owned, WAF write token)", () => {
  it("refuses to construct without the WAF write token (fail closed)", () => {
    expect(() => createRulesetsClient("")).toThrow(RulesetsApiError);
  });

  it("sends the write token as a bearer header and POSTs a single rule, not a whole ruleset", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init?.method === "POST") {
        capturedHeaders = init.headers;
        const body = JSON.parse(init.body ?? "{}");
        expect(body).not.toHaveProperty("rules");
        expect(url).toContain(`/zones/${ZONE}/rulesets/${RULESET_ID}/rules`);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errors: [],
          messages: [],
          result: {
            id: RULESET_ID,
            name: "Block scanner traffic",
            phase: RECOMMENDATION_PHASE,
            version: "2",
            rules: [
              { id: "cf-rule-1", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description },
            ],
          },
        }),
      };
    };
    const client = createRulesetsClient("waf-token-abc", fetchImpl as never);
    const updated = await client.createRule(ZONE, RULESET_ID, RULE);
    expect(updated.rules[0].id).toBe("cf-rule-1");
    expect(capturedHeaders?.Authorization).toBe("Bearer waf-token-abc");
  });

  it("throws on a non-success API response", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, errors: [{ message: "bad expression" }], messages: [] }),
    });
    const client = createRulesetsClient("waf-token", fetchImpl as never);
    await expect(client.createRule(ZONE, RULESET_ID, RULE)).rejects.toThrow(RulesetsApiError);
  });
});

describe("reconcileOrCreate (read-before-write recovery)", () => {
  it("POSTs a single rule when none exists and extracts the created id from the response", async () => {
    const client = new FakeRulesets();
    const result = await reconcileOrCreate(client, TARGET, RULE);
    expect(result.created).toBe(true);
    expect(result.cloudflareRuleId).toMatch(/^cf-rule-\d+$/);
    expect(client.posts).toHaveLength(1);
  });

  it("recovers an existing matching rule by stable ref without POSTing (uncertain outcome)", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-early", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, enabled: true },
    ];
    const result = await reconcileOrCreate(client, TARGET, RULE);
    expect(result.created).toBe(false);
    expect(result.cloudflareRuleId).toBe("cf-early");
    expect(client.posts).toHaveLength(0); // adopted, not re-created
  });

  it("aborts on a conflicting stable reference with a different payload", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-conflict", ref: RULE.ref, expression: "http.host eq \"other\"", action: "managed_challenge", enabled: true },
    ];
    await expect(reconcileOrCreate(client, TARGET, RULE)).rejects.toThrow(/different payload; aborting/);
  });

  it("aborts on duplicate stable references", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-1", ref: RULE.ref, expression: RULE.expression, action: RULE.action, enabled: true },
      { id: "cf-2", ref: RULE.ref, expression: RULE.expression, action: RULE.action, enabled: true },
    ];
    await expect(reconcileOrCreate(client, TARGET, RULE)).rejects.toThrow(/duplicate stable rule references/);
  });
});

describe("verifyRuleReadAfterWrite", () => {
  it("returns true when the created rule matches the exact payload", async () => {
    const client = new FakeRulesets();
    const created = await reconcileOrCreate(client, TARGET, RULE);
    const ok = await verifyRuleReadAfterWrite(client, TARGET, created.cloudflareRuleId, RULE);
    expect(ok).toBe(true);
  });

  it("returns false when the rule is missing", async () => {
    const client = new FakeRulesets();
    const ok = await verifyRuleReadAfterWrite(client, TARGET, "cf-nonexistent", RULE);
    expect(ok).toBe(false);
  });

  it("returns false when the rule payload differs", async () => {
    const client = new FakeRulesets();
    const created = await reconcileOrCreate(client, TARGET, RULE);
    client.rules = client.rules.map((r) =>
      r.id === created.cloudflareRuleId ? { ...r, expression: "http.host eq \"changed\"" } : r,
    );
    const ok = await verifyRuleReadAfterWrite(client, TARGET, created.cloudflareRuleId, RULE);
    expect(ok).toBe(false);
  });
});

describe("ruleMatchesMutation", () => {
  it("matches on identical payload + ref", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description },
        RULE,
        TARGET,
      ),
    ).toBe(true);
  });

  it("mismatches when the ref differs", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: "botguard-R-9999", expression: RULE.expression, action: RULE.action, description: RULE.description },
        RULE,
        TARGET,
      ),
    ).toBe(false);
  });

  it("mismatches when the API rule action differs from the submitted action", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: "block", description: RULE.description },
        RULE,
        TARGET,
      ),
    ).toBe(false);
  });

  it("matches when the API rule action equals the submitted action", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description },
        RULE,
        TARGET,
      ),
    ).toBe(true);
  });

  it("adopts a matching rule whose enabled field is absent (default true)", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description },
        RULE,
        TARGET,
      ),
    ).toBe(true);
  });

  it("refuses a matching rule explicitly disabled", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, enabled: false },
        RULE,
        TARGET,
      ),
    ).toBe(false);
  });

  it("matches a rule with empty action_parameters (approved payload has none)", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: {} },
        RULE,
        TARGET,
      ),
    ).toBe(true);
  });

  it("mismatches a rule with non-empty action_parameters", () => {
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: { challenge_ui: "skip" } },
        RULE,
        TARGET,
      ),
    ).toBe(false);
  });

  it("matches a submitted rule whose non-empty action_parameters exactly equal the API rule's", () => {
    // The submitted payload carries non-empty params; the API rule has the SAME
    // params, so the expected hash (built from rule.action_parameters) matches.
    const ruleWithParams = { ...RULE, action_parameters: { challenge_ui: "skip" } };
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: { challenge_ui: "skip" } },
        ruleWithParams,
        TARGET,
      ),
    ).toBe(true);
  });

  it("mismatches a submitted rule whose non-empty action_parameters differ from the API rule's", () => {
    const ruleWithParams = { ...RULE, action_parameters: { challenge_ui: "skip" } };
    expect(
      ruleMatchesMutation(
        { id: "x", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: { challenge_ui: "managed_challenge" } },
        ruleWithParams,
        TARGET,
      ),
    ).toBe(false);
  });
});

describe("reconcileOrCreate / verifyRuleReadAfterWrite disabled & action conflicts", () => {
  it("aborts reconciliation when the existing rule is explicitly disabled", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-disabled", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, enabled: false },
    ];
    await expect(reconcileOrCreate(client, TARGET, RULE)).rejects.toThrow(/different payload; aborting/);
  });

  it("aborts reconciliation when the existing rule has a different action", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-blocked", ref: RULE.ref, expression: RULE.expression, action: "block", description: RULE.description },
    ];
    await expect(reconcileOrCreate(client, TARGET, RULE)).rejects.toThrow(/different payload; aborting/);
  });

  it("verification returns false for an explicitly disabled rule", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-disabled", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, enabled: false },
    ];
    const ok = await verifyRuleReadAfterWrite(client, TARGET, "cf-disabled", RULE);
    expect(ok).toBe(false);
  });

  it("verification returns false for a rule with a conflicting action", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-blocked", ref: RULE.ref, expression: RULE.expression, action: "block", description: RULE.description },
    ];
    const ok = await verifyRuleReadAfterWrite(client, TARGET, "cf-blocked", RULE);
    expect(ok).toBe(false);
  });

  it("adopts an existing enabled rule whose enabled field is absent (default true)", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-early", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description },
    ];
    const result = await reconcileOrCreate(client, TARGET, RULE);
    expect(result.created).toBe(false);
    expect(result.cloudflareRuleId).toBe("cf-early");
    expect(client.posts).toHaveLength(0);
  });

  it("aborts reconciliation when the existing rule has non-empty action_parameters", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-params", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: { challenge_ui: "skip" } },
    ];
    await expect(reconcileOrCreate(client, TARGET, RULE)).rejects.toThrow(/different payload; aborting/);
  });

  it("verification returns false for a rule with non-empty action_parameters", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-params", ref: RULE.ref, expression: RULE.expression, action: RULE.action, description: RULE.description, action_parameters: { challenge_ui: "skip" } },
    ];
    const ok = await verifyRuleReadAfterWrite(client, TARGET, "cf-params", RULE);
    expect(ok).toBe(false);
  });
});