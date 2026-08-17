import { describe, expect, it } from "vitest";

import { createIssueRecommendationTool } from "../src/tools/issue-recommendation.ts";
import { createApplyRecommendationTool } from "../src/tools/apply-approved-recommendation.ts";
import { RECOMMENDATION_PHASE } from "../src/shared/recommendation.ts";
import type { ZoneAgentState } from "../src/shared/types.ts";
import type { ZoneConfig } from "../src/registry/zone-registry.ts";
import type { ZoneSliceSetterValue } from "../src/tools/zone-context.ts";
import { FakeRulesets, fakeStep, durableContext } from "./helpers/fake-rulesets.ts";

const ZONE = "zone-a";
const NON_DEFAULT_PHASE = "http_custom_phase";
const RULESET_ID = "ruleset-a";
const SECRET = "secret";

function configFor(phase: string): ZoneConfig {
  return {
    zoneId: ZONE,
    hostname: "a.example.com",
    rulesetId: RULESET_ID,
    rulesetPhase: phase,
    rulesetVersion: "1",
    enabled: true,
    allowedEnvelopeSenders: [],
    reportSender: "",
    reportRecipient: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function zoneContextFor(phase: string, slices: Record<string, ZoneAgentState>) {
  return {
    resolveZoneConfig: async (zoneId: string) =>
      zoneId === ZONE ? configFor(phase) : null,
    resolveSlice: (zoneId: string) => slices[zoneId] ?? emptySlice(zoneId),
    setSlice: (zoneId: string, value: ZoneSliceSetterValue) => {
      slices[zoneId] = typeof value === "function" ? value(slices[zoneId] ?? emptySlice(zoneId)) : value;
    },
  };
}

function emptySlice(zoneId: string): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId,
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
  };
}

describe("D1 ruleset_phase is authoritative", () => {
  it("issue_recommendation records the D1 ruleset_phase, not the hardcoded default", async () => {
    const slices: Record<string, ZoneAgentState> = {};
    const tool = createIssueRecommendationTool({
      zoneId: ZONE,
      secret: SECRET,
      rulesetId: "",
      rulesetVersion: "",
      setState: () => {},
      zoneContext: zoneContextFor(NON_DEFAULT_PHASE, slices),
      now: new Date("2026-08-12T00:00:00Z"),
    });
    const result = (await tool.run({
      toolCallId: "c",
      signal: undefined,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
      data: {
        findingId: "F-1",
        type: "datacenter_scraping",
        expression: "ip.src.asnum in {16509} and not cf.client.bot",
        description: "desc",
        evidence: [],
        confidence: 0.9,
        risk: "medium",
        expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "x", blastRadius: "bounded" },
      },
    } as never)) as { output: { recommendationId: string } };
    const rec = slices[ZONE].recommendations.find((r) => r.id === result.output.recommendationId);
    expect(rec?.phase).toBe(NON_DEFAULT_PHASE);
    expect(rec?.phase).not.toBe(RECOMMENDATION_PHASE);
  });

  it("issue_recommendation keeps the default phase in backward (no zoneContext) mode", async () => {
    let slice: ZoneAgentState = emptySlice(ZONE);
    const tool = createIssueRecommendationTool({
      zoneId: ZONE,
      secret: SECRET,
      rulesetId: RULESET_ID,
      rulesetVersion: "1",
      setState: (value) => {
        slice = typeof value === "function" ? value(slice) : value;
      },
      now: new Date("2026-08-12T00:00:00Z"),
    });
    const result = (await tool.run({
      toolCallId: "c",
      signal: undefined,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
      data: {
        findingId: "F-1",
        type: "datacenter_scraping",
        expression: "ip.src.asnum in {16509} and not cf.client.bot",
        description: "desc",
        evidence: [],
        confidence: 0.9,
        risk: "medium",
        expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "x", blastRadius: "bounded" },
      },
    } as never)) as { output: { recommendationId: string } };
    const rec = slice.recommendations.find((r) => r.id === result.output.recommendationId);
    expect(rec?.phase).toBe(RECOMMENDATION_PHASE);
  });

  it("apply uses the D1 ruleset_phase as the target and cross-checks it", async () => {
    const slices: Record<string, ZoneAgentState> = { [ZONE]: emptySlice(ZONE) };
    // First issue a recommendation under the non-default phase.
    const issue = createIssueRecommendationTool({
      zoneId: ZONE,
      secret: SECRET,
      rulesetId: "",
      rulesetVersion: "",
      setState: () => {},
      zoneContext: zoneContextFor(NON_DEFAULT_PHASE, slices),
      now: new Date("2026-08-12T00:00:00Z"),
    });
    const issued = (await issue.run({
      toolCallId: "c", signal: undefined,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
      data: {
        findingId: "F-1", type: "datacenter_scraping",
        expression: "ip.src.asnum in {16509} and not cf.client.bot",
        description: "desc", evidence: [],
        confidence: 0.9, risk: "medium",
        expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "x", blastRadius: "bounded" },
      },
    } as never)) as { output: { recommendationId: string } };
    const recommendationId = issued.output.recommendationId;
    const rec = slices[ZONE].recommendations[0];
    const approvalTokenId = slices[ZONE].approvalTokens[0].tokenId;

    // Approve it so the apply tool can authorize.
    const approved: ZoneAgentState = {
      ...slices[ZONE],
      recommendations: [{ ...rec, status: "approved" }],
      approvalTokens: slices[ZONE].approvalTokens.map((t) => ({ ...t, consumedAt: "2026-08-12T00:00:00Z" })),
      approvedRecords: [
        {
          recommendationId: rec.id,
          mutationId: rec.mutationId,
          payloadHash: rec.payloadHash,
          approvedAt: "2026-08-12T00:00:00Z",
          approvalTokenId,
          status: "approved",
        } as never,
      ],
    };
    slices[ZONE] = approved;

    const client = new FakeRulesets();
    const apply = createApplyRecommendationTool({
      zoneId: ZONE,
      config: { rulesetId: RULESET_ID, rulesetVersion: "1" },
      client,
      state: approved,
      setState: () => {},
      now: new Date("2026-08-12T00:00:00Z"),
      zoneContext: zoneContextFor(NON_DEFAULT_PHASE, slices),
    });
    const step = fakeStep();
    const result = (await apply.run(
      durableContext({ recommendationId, approvalTokenId, zoneId: ZONE }, step),
    )) as { output: { applied: boolean; reason: string } };
    // Matches the D1 phase → applies, and the POSTed rule targets that phase.
    expect(result.output.applied).toBe(true);
    expect(client.posts[0].rule).toBeDefined();
    // The stored recommendation carried the non-default phase, which equals D1.
    expect(slices[ZONE].recommendations[0].status).toBe("monitoring");
  });

  it("apply fails closed when the stored phase no longer matches D1 (phase mismatch)", async () => {
    const slices: Record<string, ZoneAgentState> = { [ZONE]: emptySlice(ZONE) };
    // Issue under the DEFAULT phase, then apply with a D1 config that now uses a
    // different phase → authorizeApplication must deny (rec.phase != config.phase).
    const issue = createIssueRecommendationTool({
      zoneId: ZONE,
      secret: SECRET,
      rulesetId: RULESET_ID,
      rulesetVersion: "1",
      setState: (value) => {
        slices[ZONE] = typeof value === "function" ? value(slices[ZONE] ?? emptySlice(ZONE)) : value;
      },
      now: new Date("2026-08-12T00:00:00Z"),
    });
    const issued = (await issue.run({
      toolCallId: "c", signal: undefined,
      log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
      data: {
        findingId: "F-1", type: "datacenter_scraping",
        expression: "ip.src.asnum in {16509} and not cf.client.bot",
        description: "desc", evidence: [],
        confidence: 0.9, risk: "medium",
        expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "x", blastRadius: "bounded" },
      },
    } as never)) as { output: { recommendationId: string } };
    const recommendationId = issued.output.recommendationId;
    const rec = slices[ZONE].recommendations[0];
    const approvalTokenId = slices[ZONE].approvalTokens[0].tokenId;
    slices[ZONE] = {
      ...slices[ZONE],
      recommendations: [{ ...rec, status: "approved" }],
      approvalTokens: slices[ZONE].approvalTokens.map((t) => ({ ...t, consumedAt: "2026-08-12T00:00:00Z" })),
      approvedRecords: [
        { recommendationId: rec.id, mutationId: rec.mutationId, payloadHash: rec.payloadHash, approvedAt: "2026-08-12T00:00:00Z", approvalTokenId, status: "approved" },
      ],
    };

    const client = new FakeRulesets();
    const apply = createApplyRecommendationTool({
      zoneId: ZONE,
      config: { rulesetId: RULESET_ID, rulesetVersion: "1" },
      client,
      state: slices[ZONE],
      setState: () => {},
      now: new Date("2026-08-12T00:00:00Z"),
      zoneContext: zoneContextFor(NON_DEFAULT_PHASE, slices),
    });
    const step = fakeStep();
    const result = (await apply.run(
      durableContext({ recommendationId, approvalTokenId, zoneId: ZONE }, step),
    )) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("authorization_denied");
    expect(result.output.reason).toContain("phase");
    expect(client.posts).toHaveLength(0);
  });
});
