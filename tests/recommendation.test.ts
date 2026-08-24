import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRecommendation,
  DEFAULT_RECOMMENDATION_TTL_MS,
  mutationIdOf,
  mutationPayload,
  payloadHashOf,
  validateRecommendation,
  classifyRisk,
  RECOMMENDATION_PHASE,
  type CreateRecommendationInput,
} from "../src/shared/recommendation.ts";

const ZONE_ID = "zone-abc";
const RULESET_ID = "ruleset-1";
const RULESET_VERSION = "42";

function baseInput(overrides: Record<string, unknown> = {}): CreateRecommendationInput {
  return {
    findingId: "F-1",
    zoneId: ZONE_ID,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    type: "datacenter_scraping",
    expression: "(ip.src.asnum in {16509 14618}) and not cf.client.bot",
    description: "AWS-hosted clients fetch profile pages sequentially.",
    evidence: [{ label: "7.8x increase from baseline", value: "evidence" }],
    confidence: 0.91,
    risk: "medium",
    expectedImpact: {
      requestRatePerDay: 84210,
      likelyLegitimateExposure: "~0.3% heuristic",
      blastRadius: "bounded",
    },
    rulesetId: RULESET_ID,
    rulesetVersion: RULESET_VERSION,
    stableRuleRef: "botguard-R-1042",
    id: "R-1042",
    ...overrides,
  };
}

describe("payload hash", () => {
  it("excludes rulesetVersion from the submitted-payload hash", () => {
    const a = payloadHashOf({
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: "expr", description: "desc",
      stableRuleRef: "botguard-R-1", actionParameters: {},
    });
    const b = payloadHashOf({
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: "expr", description: "desc",
      stableRuleRef: "botguard-R-1", actionParameters: {},
    });
    expect(a).toBe(b);
    // mutationPayload() never contains a rulesetVersion field.
    expect(JSON.stringify(mutationPayload({
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: "expr", description: "desc",
      stableRuleRef: "botguard-R-1", actionParameters: {},
    }))).not.toContain("rulesetVersion");
  });

  it("flips the hash when any mutation field changes", () => {
    const base = {
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge" as const, expression: "expr", description: "desc",
      stableRuleRef: "botguard-R-1", actionParameters: {},
    };
    const hash = payloadHashOf(base);
    expect(payloadHashOf({ ...base, expression: "expr2" })).not.toBe(hash);
    expect(payloadHashOf({ ...base, stableRuleRef: "botguard-R-2" })).not.toBe(hash);
    expect(payloadHashOf({ ...base, rulesetId: "other" })).not.toBe(hash);
    expect(payloadHashOf({ ...base, actionParameters: { ui: "on" } })).not.toBe(hash);
  });

  it("produces a stable mutation id derived from the hash", () => {
    const m = {
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge" as const, expression: "expr", description: "desc",
      stableRuleRef: "botguard-R-1", actionParameters: {},
    };
    expect(mutationIdOf(m)).toBe(mutationIdOf(m));
    expect(mutationIdOf(m)).toMatch(/^m-[0-9a-f]{16}$/);
  });
});

describe("createRecommendation (immutability)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives mutationId and payloadHash deterministically", () => {
    const r1 = createRecommendation(baseInput());
    const r2 = createRecommendation(baseInput());
    expect(r1).toEqual(r2);
    expect(r1.status).toBe("pending_approval");
    expect(r1.action).toBe("managed_challenge");
    expect(r1.mutationId).toBe(mutationIdOf({
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: r1.expression, description: r1.description,
      stableRuleRef: r1.stableRuleRef, actionParameters: {},
    }));
    expect(r1.payloadHash).toBe(payloadHashOf({
      zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, rulesetId: RULESET_ID,
      action: "managed_challenge", expression: r1.expression, description: r1.description,
      stableRuleRef: r1.stableRuleRef, actionParameters: {},
    }));
  });

  it("is immutable: no mutation field is writable after creation", () => {
    const r = createRecommendation(baseInput());
    // A changed mutation field must produce a NEW recommendation, never an edit.
    const changed = createRecommendation(baseInput({ expression: "other expression" }));
    expect(changed.expression).not.toBe(r.expression);
    expect(changed.mutationId).not.toBe(r.mutationId);
    expect(changed.payloadHash).not.toBe(r.payloadHash);
    expect(changed.id).toBe("R-1042"); // finding/id may stay stable; new mutation is a new revision
  });

  it("records rulesetVersion as context but not in the hash", () => {
    const a = createRecommendation(baseInput({ rulesetVersion: "42" }));
    const b = createRecommendation(baseInput({ rulesetVersion: "99" }));
    expect(a.rulesetVersion).toBe("42");
    expect(b.rulesetVersion).toBe("99");
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.mutationId).toBe(b.mutationId);
  });

  it("applies the default validity window", () => {
    const now = new Date("2026-08-13T00:00:00Z");
    const expiresAt = new Date(now.getTime() + DEFAULT_RECOMMENDATION_TTL_MS).toISOString();
    const r = createRecommendation(baseInput({ createdAt: now.toISOString(), expiresAt }));
    expect(r.expiresAt).toBe(expiresAt);
  });
});

describe("deterministic validation / risk policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a valid bounded medium-risk recommendation", () => {
    const r = createRecommendation(baseInput());
    expect(r.risk).toBe("medium");
  });

  it("rejects a payloadHash mismatch", () => {
    const validation = validateRecommendation({
      id: "R-1042", zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, action: "managed_challenge",
      expression: "expr", description: "desc", confidence: 0.91, risk: "medium",
      expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" },
      rulesetId: RULESET_ID, stableRuleRef: "botguard-R-1042", mutationId: "m-x",
      payloadHash: "deadbeef", expiresAt: "2026-08-20T00:00:00Z",
    });
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("payloadHash mismatch");
  });

  it("rejects a broad blast radius in expectedImpact", () => {
    expect(() =>
      createRecommendation(baseInput({
        expectedImpact: { ...baseInput().expectedImpact, blastRadius: "broad" },
      })),
    ).toThrow(/not email-approvable: blast radius is not bounded/);
  });

  it("rejects confidence below MIN_APPROVAL_CONFIDENCE", () => {
    expect(() =>
      createRecommendation(baseInput({ confidence: 0.7 })),
    ).toThrow(/confidence below minimum approval threshold/);
  });

  it("uses an injected clock for deterministic expiry validation", () => {
    // Expiry far in the future passes at the injected reference time...
    const ok = validateRecommendation({
      id: "R-1042", zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, action: "managed_challenge",
      expression: "expr", description: "desc", confidence: 0.91, risk: "medium",
      expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" },
      rulesetId: RULESET_ID, stableRuleRef: "botguard-R-1042", mutationId: "m-x",
      payloadHash: "deadbeef", expiresAt: "2026-08-20T00:00:00Z",
    }, new Date("2026-08-13T00:00:00Z"));
    expect(ok.valid).toBe(false); // fails only on payloadHash, not expiry
    expect(ok.reasons).not.toContain("expires in the past");

    // ...but the same expiresAt is "in the past" at a later reference time.
    const late = validateRecommendation({
      id: "R-1042", zoneId: ZONE_ID, phase: RECOMMENDATION_PHASE, action: "managed_challenge",
      expression: "expr", description: "desc", confidence: 0.91, risk: "medium",
      expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" },
      rulesetId: RULESET_ID, stableRuleRef: "botguard-R-1042", mutationId: "m-x",
      payloadHash: "deadbeef", expiresAt: "2026-08-20T00:00:00Z",
    }, new Date("2026-09-01T00:00:00Z"));
    expect(late.reasons).toContain("expires in the past");
  });

  it("rejects an expired recommendation", () => {
    expect(() =>
      createRecommendation(baseInput({ expiresAt: "2020-01-01T00:00:00Z" })),
    ).toThrow(/expires in the past/);
  });

  it("classifies high risk as not email-approvable", () => {
    expect(classifyRisk("high", "bounded").approvable).toBe(false);
  });

  it("classifies a broad blast radius as not email-approvable", () => {
    expect(classifyRisk("medium", "broad").approvable).toBe(false);
  });

  it("classifies bounded medium risk as email-approvable", () => {
    expect(classifyRisk("medium", "bounded").approvable).toBe(true);
  });
});