import { describe, expect, it } from "vitest";

import { createApplyRecommendationTool } from "../src/tools/apply-approved-recommendation.ts";
import { RECOMMENDATION_PHASE, mutationIdOf, payloadHashOf } from "../src/shared/recommendation.ts";
import type { Recommendation, ZoneAgentState } from "../src/shared/types.ts";
import type { ZoneConfig } from "../src/registry/zone-registry.ts";
import type { ZoneSliceSetterValue } from "../src/tools/zone-context.ts";
import { FakeRulesets, fakeStep, durableContext } from "./helpers/fake-rulesets.ts";

const ZONE_A = "zone-a";
const ZONE_B = "zone-b";
const RULESET_A = "ruleset-a";
const RULESET_B = "ruleset-b";
const REC_ID = "R-1042";
const TOKEN_ID = "tok-1";
const NOW = new Date("2026-08-15T00:00:00Z");
const EXPRESSION = "(ip.src.asnum in {16509 14618}) and not cf.client.bot";

function configFor(zoneId: string, rulesetId: string): ZoneConfig {
  return {
    zoneId,
    hostname: `${zoneId}.example.com`,
    rulesetId,
    rulesetPhase: RECOMMENDATION_PHASE,
    rulesetVersion: "1",
    enabled: true,
    allowedEnvelopeSenders: [],
    reportSender: "",
    reportRecipient: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  const base = {
    id: REC_ID,
    findingId: "F-1",
    zoneId: ZONE_A,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    status: "approved" as const,
    type: "datacenter_scraping",
    action: "managed_challenge" as const,
    phase: RECOMMENDATION_PHASE,
    expression: EXPRESSION,
    description: "desc",
    evidence: [{ label: "e", value: "v" }],
    confidence: 0.91,
    risk: "medium" as const,
    expectedImpact: { requestRatePerDay: 10, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" as const },
    rulesetId: RULESET_A,
    rulesetVersion: "1",
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

/** A zone-a slice with an approved, token-issued recommendation. */
function approvedSliceA(): ZoneAgentState {
  const rec = makeRecommendation();
  return {
    ...emptySlice(ZONE_A),
    recommendations: [rec],
    approvalTokens: [
      {
        tokenId: TOKEN_ID,
        recommendationId: REC_ID,
        zoneId: ZONE_A,
        decision: "APPLY" as const,
        createdAt: "2026-08-13T00:00:00Z",
        expiresAt: "2026-08-20T00:00:00Z",
        payload: JSON.stringify({ recommendationId: REC_ID, zoneId: ZONE_A }),
        signedToken: "a.b",
        consumedAt: NOW.toISOString(),
      },
    ],
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
  };
}

describe("apply tool cross-zone denial", () => {
  function build() {
    const slices: Record<string, ZoneAgentState> = {
      [ZONE_A]: approvedSliceA(),
      [ZONE_B]: emptySlice(ZONE_B),
    };
    const configs: Record<string, ZoneConfig> = {
      [ZONE_A]: configFor(ZONE_A, RULESET_A),
      [ZONE_B]: configFor(ZONE_B, RULESET_B),
    };
    const client = new FakeRulesets();
    const zoneContext = {
      resolveZoneConfig: async (zoneId: string) => configs[zoneId] ?? null,
      resolveSlice: (zoneId: string) => slices[zoneId] ?? emptySlice(zoneId),
      setSlice: (zoneId: string, value: ZoneSliceSetterValue) => {
        slices[zoneId] = typeof value === "function" ? value(slices[zoneId] ?? emptySlice(zoneId)) : value;
      },
      resolveBucket: () => ({} as never),
    };
    const tool = createApplyRecommendationTool({
      zoneId: ZONE_A,
      config: { rulesetId: RULESET_A, rulesetVersion: "1" },
      client,
      state: slices[ZONE_A],
      setState: () => {},
      sender: { sendConfirmation: async () => ({ sent: true, transport: "fake", detail: "mocked" }) },
      now: NOW,
      zoneContext,
    });
    return { tool, client, getSlice: (z: string) => slices[z] };
  }

  it("applies the recommendation when the model supplies the owning zoneId", async () => {
    const { tool, client, getSlice } = build();
    const step = fakeStep();
    const result = (await tool.run(
      durableContext({ recommendationId: REC_ID, approvalTokenId: TOKEN_ID, zoneId: ZONE_A }, step),
    )) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(true);
    expect(client.posts).toHaveLength(1);
    expect(getSlice(ZONE_A).recommendations[0].status).toBe("monitoring");
    // zone-b slice remains untouched.
    expect(getSlice(ZONE_B).appliedRules).toHaveLength(0);
  });

  it("denies cross-zone application: a zone-a recommendation is not visible in zone-b", async () => {
    const { tool, client, getSlice } = build();
    const step = fakeStep();
    const result = (await tool.run(
      durableContext({ recommendationId: REC_ID, approvalTokenId: TOKEN_ID, zoneId: ZONE_B }, step),
    )) as { output: { applied: boolean; reason: string } };
    expect(result.output.applied).toBe(false);
    expect(result.output.reason).toContain("authorization_denied");
    expect(result.output.reason).toContain("unknown_recommendation");
    // No mutation, no state transition anywhere.
    expect(client.posts).toHaveLength(0);
    expect(getSlice(ZONE_A).recommendations[0].status).toBe("approved");
    expect(getSlice(ZONE_B).recommendations).toHaveLength(0);
  });

  it("rejects an unknown/disabled zone supplied by the model", async () => {
    const { tool, client } = build();
    const step = fakeStep();
    await expect(
      tool.run(durableContext({ recommendationId: REC_ID, approvalTokenId: TOKEN_ID, zoneId: "zone-nope" }, step)),
    ).rejects.toThrow(/unknown or disabled zone/);
    expect(client.posts).toHaveLength(0);
  });
});