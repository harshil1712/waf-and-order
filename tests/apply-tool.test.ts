import { describe, expect, it } from "vitest";

import { createApplyRecommendationTool } from "../src/tools/apply-approved-recommendation.ts";
import type { ZoneStateSetter } from "../src/tools/issue-recommendation.ts";
import type { ConfirmationSender } from "../src/email/sender.ts";
import { RECOMMENDATION_PHASE, mutationIdOf, payloadHashOf } from "../src/shared/recommendation.ts";
import type { Recommendation, ZoneAgentState } from "../src/shared/types.ts";
import { FakeRulesets, fakeStep, durableContext } from "./helpers/fake-rulesets.ts";

const ZONE = "zone-abc";
const RULESET_ID = "abcdefabcdefabcdefabcdefabcdefab";
const RULESET_VERSION = "2";
const REC_ID = "R-1042";
const TOKEN_ID = "tok-1111111111111111";
const NOW = new Date("2026-08-15T00:00:00Z");
const EXPRESSION = "(ip.src.asnum in {16509 14618}) and not cf.client.bot";
const DESCRIPTION = "desc";

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  const base = {
    id: REC_ID,
    findingId: "F-1",
    zoneId: ZONE,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    status: "approved" as const,
    type: "datacenter_scraping",
    action: "managed_challenge" as const,
    phase: RECOMMENDATION_PHASE,
    expression: EXPRESSION,
    description: DESCRIPTION,
    evidence: [{ label: "e", value: "v" }],
    confidence: 0.91,
    risk: "medium" as const,
    expectedImpact: { requestRatePerDay: 10, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" as const },
    rulesetId: RULESET_ID,
    rulesetVersion: RULESET_VERSION,
    stableRuleRef: "botguard-R-1042",
  };
  const mutation = {
    zoneId: base.zoneId,
    phase: base.phase,
    rulesetId: base.rulesetId,
    action: base.action,
    expression: base.expression,
    description: base.description,
    stableRuleRef: base.stableRuleRef,
    actionParameters: {},
  };
  return {
    ...base,
    mutationId: mutationIdOf(mutation),
    payloadHash: payloadHashOf(mutation),
    ...overrides,
  };
}

function tokenRecord() {
  return {
    tokenId: TOKEN_ID,
    recommendationId: REC_ID,
    zoneId: ZONE,
    decision: "APPLY" as const,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    payload: JSON.stringify({ recommendationId: REC_ID, zoneId: ZONE }),
    signedToken: "a.b",
    consumedAt: NOW.toISOString(),
  };
}

function state(overrides: Partial<ZoneAgentState> = {}): ZoneAgentState {
  const rec = makeRecommendation();
  return {
    schemaVersion: 2,
    zoneId: ZONE,
    recommendations: [rec],
    approvalTokens: [tokenRecord()],
    approvedRecords: [
      {
        recommendationId: REC_ID,
        mutationId: rec.mutationId,
        payloadHash: rec.payloadHash,
        approvedAt: NOW.toISOString(),
        approvalTokenId: TOKEN_ID,
        status: "approved",
      },
    ],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    ...overrides,
  };
}

interface MakeToolOpts {
  state?: ZoneAgentState;
  client?: FakeRulesets;
  sender?: ConfirmationSender;
}

function makeTool(opts: MakeToolOpts = {}) {
  const client = opts.client ?? new FakeRulesets();
  let current = opts.state ?? state();
  const setState: ZoneStateSetter = (updater) => {
    current = typeof updater === "function" ? updater(current) : updater;
  };
  const tool = createApplyRecommendationTool({
    zoneId: ZONE,
    config: { rulesetId: RULESET_ID, rulesetVersion: RULESET_VERSION },
    client,
    state: opts.state ?? state(),
    setState,
    sender: opts.sender,
    now: NOW,
  });
  return { tool, client, getState: () => current };
}

const INPUT = { recommendationId: REC_ID, approvalTokenId: TOKEN_ID };
const fakeSender = {
  sendConfirmation: async () => ({ sent: true, transport: "fake", detail: "mocked" }),
};

describe("createApplyRecommendationTool", () => {
  it("applies exactly once via a single-rule POST, records the rule id, and reaches monitoring", async () => {
    const { tool, client, getState } = makeTool({ sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; cloudflareRuleId?: string; reason: string } };

    expect(result.output.applied).toBe(true);
    expect(result.output.cloudflareRuleId).toMatch(/^cf-rule-\d+$/);
    // Exactly one single-rule POST; the created rule carries the stable ref.
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].rule).toMatchObject({
      expression: EXPRESSION,
      action: "managed_challenge",
      ref: "botguard-R-1042",
    });
    // Unrelated rules preserved: no PUT of the whole list, only a POST.
    expect(client.posts[0].rule).not.toHaveProperty("rules");
    // State reached monitoring with the authoritative rule id recorded.
    expect(getState().recommendations[0].status).toBe("monitoring");
    expect(getState().recommendations[0].cloudflareRuleId).toBe(result.output.cloudflareRuleId);
    expect(getState().appliedRules[0].cloudflareRuleId).toBe(result.output.cloudflareRuleId);
    expect(getState().appliedRules[0].mutationId).toBe(getState().recommendations[0].mutationId);
  });

  it("extracts the created rule id from the POST response (authoritative record)", async () => {
    const client = new FakeRulesets();
    client.nextRuleId = "cf-rule-42";
    const { tool, getState } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { cloudflareRuleId?: string } };
    expect(result.output.cloudflareRuleId).toBe("cf-rule-42");
    expect(getState().appliedRules[0].cloudflareRuleId).toBe("cf-rule-42");
  });

  it("preserves unrelated rules already present in the ruleset", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "pre-existing", ref: "some-other-ref", expression: "http.host eq \"x\"", action: "block", enabled: true },
    ];
    const { tool } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    await tool.run(durableContext(INPUT, step));
    expect(client.rules).toHaveLength(2);
    expect(client.rules[0].id).toBe("pre-existing"); // untouched
    expect(client.rules[1].ref).toBe("botguard-R-1042");
  });

  it("recovers from an uncertain POST (no duplicate) via read-before-write on retry", async () => {
    // Simulate a retried durable execution: the first run POSTs and records the
    // result, then the tool is re-invoked on the SAME ruleset. Reconcile finds
    // the stable ref already present and adopts its id — no second POST.
    const client = new FakeRulesets();
    const { tool, getState } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    const first = (await tool.run(durableContext(INPUT, step))) as { output: { cloudflareRuleId?: string } };
    expect(client.posts).toHaveLength(1);

    // Re-invoke with a FRESH step (simulating recovery after the record replay):
    // reconcile now reads the ruleset and finds the rule already present.
    const step2 = fakeStep();
    const second = (await tool.run(durableContext(INPUT, step2))) as { output: { cloudflareRuleId?: string } };
    expect(client.posts).toHaveLength(1); // no duplicate POST
    expect(second.output.cloudflareRuleId).toBe(first.output.cloudflareRuleId);
    expect(getState().appliedRules).toHaveLength(1); // authoritative record converges
  });

  it("aborts on a conflicting stable reference (same ref, different payload)", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-conflict", ref: "botguard-R-1042", expression: "http.host eq \"other\"", action: "managed_challenge", enabled: true },
    ];
    const { tool } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    await expect(tool.run(durableContext(INPUT, step))).rejects.toThrow(/different payload; aborting/);
  });

  it("aborts on duplicate stable references", async () => {
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-dup-1", ref: "botguard-R-1042", expression: EXPRESSION, action: "managed_challenge", enabled: true },
      { id: "cf-dup-2", ref: "botguard-R-1042", expression: EXPRESSION, action: "managed_challenge", enabled: true },
    ];
    const { tool } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    await expect(tool.run(durableContext(INPUT, step))).rejects.toThrow(/duplicate stable rule references/);
  });

  it("fails (no mutation) on a read-after-write mismatch", async () => {
    const client = new FakeRulesets();
    // After the POST, mutate the created rule so the read-after-write verify fails.
    const origCreate = client.createRule.bind(client);
    client.createRule = async (z, r, rule) => {
      const ruleset = await origCreate(z, r, rule);
      client.rules = client.rules.map((x) =>
        x.ref === rule.ref ? { ...x, expression: "http.host eq \"changed\"" } : x,
      );
      return ruleset;
    };
    const { tool } = makeTool({ client, sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toBe("read_after_write_mismatch");
  });

  it("does not transition state when authorization is denied (unapproved)", async () => {
    const s = state();
    s.recommendations[0].status = "pending_approval";
    const { tool, getState } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("authorization_denied");
    expect(getState().recommendations[0].status).toBe("pending_approval"); // unchanged
  });

  it("rejects an expired recommendation", async () => {
    const s = state();
    s.recommendations[0].expiresAt = "2020-01-01T00:00:00Z";
    const { tool } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("expired");
  });

  it("rejects a wrong approval token (hash/record binding)", async () => {
    const { tool } = makeTool({ sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext({ recommendationId: REC_ID, approvalTokenId: "tok-wrong" }, step))) as {
      output: { applied: boolean; reason: string };
    };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("authorization_denied");
  });

  it("rejects a tampered payload hash", async () => {
    const s = state();
    s.recommendations[0].payloadHash = "deadbeef";
    const { tool } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("recomputed payloadHash");
  });

  it("rejects an injected/broad-scope expression at apply time", async () => {
    const s = state();
    s.recommendations[0].expression = "true";
    s.recommendations[0].payloadHash = payloadHashOf({
      zoneId: ZONE, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: "true", description: DESCRIPTION,
      stableRuleRef: "botguard-R-1042", actionParameters: {},
    });
    s.recommendations[0].mutationId = mutationIdOf({
      zoneId: ZONE, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: "true", description: DESCRIPTION,
      stableRuleRef: "botguard-R-1042", actionParameters: {},
    });
    const { tool, client } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("expression:");
    expect(client.posts).toHaveLength(0); // nothing written
  });

  it("rejects when the target ruleset id differs from the trusted config", async () => {
    const s = state();
    s.recommendations[0].rulesetId = "other-ruleset";
    const { tool, client } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(client.posts).toHaveLength(0);
  });

  it("enforces the max concurrent Managed Challenge rules limit", async () => {
    const s = state();
    const active = Array.from({ length: 5 }, (_, i) =>
      makeRecommendation({ id: `R-${i + 1}`, status: "applied" as const }),
    );
    s.recommendations = [...active, makeRecommendation()];
    const { tool, client } = makeTool({ state: s, client: new FakeRulesets(), sender: fakeSender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("concurrent Managed Challenge rule limit");
    expect(client.posts).toHaveLength(0);
  });

  it("sends a fail-closed confirmation through the sender abstraction (mocked)", async () => {
    let confirmationSent = false;
    const sender = {
      sendConfirmation: async (req: { recommendationId: string; cloudflareRuleId: string }) => {
        confirmationSent = true;
        expect(req.recommendationId).toBe(REC_ID);
        expect(req.cloudflareRuleId).toMatch(/^cf-rule-\d+$/);
        return { sent: true, transport: "fake", detail: "mocked" };
      },
    };
    const { tool } = makeTool({ sender });
    const step = fakeStep();
    const result = (await tool.run(durableContext(INPUT, step))) as { output: { reason: string } };
    expect(confirmationSent).toBe(true);
    expect(result.output.reason).toContain("fake: mocked");
  });

  it("converges on duplicate invocation (idempotent, no duplicate rule/state corruption)", async () => {
    const client = new FakeRulesets();
    const { tool, getState } = makeTool({ client, sender: fakeSender });
    // Run once.
    await tool.run(durableContext(INPUT, fakeStep()));
    // Re-invoke the SAME tool with a fresh durable step on the same client+state.
    await tool.run(durableContext(INPUT, fakeStep()));
    expect(client.posts).toHaveLength(1); // exactly one POST total
    expect(client.rules.filter((r) => r.ref === "botguard-R-1042")).toHaveLength(1);
    expect(getState().appliedRules).toHaveLength(1);
    expect(getState().recommendations[0].status).toBe("monitoring");
  });
});