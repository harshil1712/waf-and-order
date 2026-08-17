import { describe, expect, it } from "vitest";

import { beginApply, markApplied, markMonitoring } from "../src/shared/apply-state.ts";
import type { Recommendation, ZoneAgentState } from "../src/shared/types.ts";

const ZONE = "zone-abc";
const TOKEN_ID = "tok-1111111111111111";
const REC_ID = "R-1042";
const NOW = new Date("2026-08-15T00:00:00Z");

function recommendation(status: Recommendation["status"] = "approved"): Recommendation {
  return {
    id: REC_ID,
    findingId: "F-1",
    zoneId: ZONE,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    status,
    type: "datacenter_scraping",
    action: "managed_challenge",
    phase: "http_request_firewall_custom",
    expression: "expr",
    description: "desc",
    evidence: [{ label: "e", value: "v" }],
    confidence: 0.91,
    risk: "medium",
    expectedImpact: { requestRatePerDay: 10, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" },
    rulesetId: "ruleset-1",
    rulesetVersion: "42",
    mutationId: "m-abcdef1234567890",
    payloadHash: "aaaa",
    stableRuleRef: "botguard-R-1042",
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
  const rec = recommendation();
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

const INTENT = { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW };

describe("application state machine", () => {
  it("transitions approved → applying → applied → monitoring in order", () => {
    const s1 = beginApply(state(), INTENT);
    expect(s1.applied).toBe(true);
    expect(s1.next!.recommendations[0].status).toBe("applying");

    const s2 = markApplied(s1.next!, INTENT, "cloudflare-rule-1");
    expect(s2.applied).toBe(true);
    expect(s2.next!.recommendations[0].status).toBe("applied");
    expect(s2.next!.recommendations[0].cloudflareRuleId).toBe("cloudflare-rule-1");
    expect(s2.next!.appliedRules[0].cloudflareRuleId).toBe("cloudflare-rule-1");
    expect(s2.next!.appliedRules[0].recommendationId).toBe(REC_ID);

    const s3 = markMonitoring(s2.next!, INTENT);
    expect(s3.applied).toBe(true);
    expect(s3.next!.recommendations[0].status).toBe("monitoring");
    expect(s3.next!.recentOutcomes[0].status).toBe("monitoring");
  });

  it("beginApply refuses when the recommendation is not approved", () => {
    const s = state({ recommendations: [recommendation("pending_approval")] });
    const out = beginApply(s, INTENT);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("not_approved");
  });

  it("beginApply refuses an expired recommendation", () => {
    const s = state();
    s.recommendations[0].expiresAt = "2020-01-01T00:00:00Z";
    const out = beginApply(s, INTENT);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("expired");
  });

  it("beginApply refuses a wrong approval token (no matching approved record)", () => {
    const out = beginApply(state(), { ...INTENT, approvalTokenId: "tok-wrong" });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("no_matching_approved_record");
  });

  it("beginApply refuses an unconsumed token", () => {
    const s = state();
    s.approvalTokens[0].consumedAt = undefined;
    const out = beginApply(s, INTENT);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("token_not_consumed");
  });

  it("beginApply converges (no-op success) when already applying", () => {
    const s = state({ recommendations: [recommendation("applying")] });
    const out = beginApply(s, INTENT);
    expect(out.applied).toBe(true);
    expect(out.reason).toBe("already_applying");
  });

  it("markApplied refuses when not applying", () => {
    const s = state({ recommendations: [recommendation("approved")] });
    const out = markApplied(s, INTENT, "rule-9");
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("not_applying");
  });

  it("markApplied converges when already applied (idempotent, no duplicate record)", () => {
    const begun = beginApply(state(), INTENT).next!;
    const once = markApplied(begun, INTENT, "rule-1");
    const rec = once.next!;
    const twice = markApplied(rec, INTENT, "rule-1");
    expect(twice.applied).toBe(true);
    expect(twice.reason).toBe("already_applied");
    expect(twice.next!.appliedRules).toHaveLength(1);
  });

  it("markMonitoring refuses when not applied", () => {
    const out = markMonitoring(state(), INTENT);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("not_applied");
  });

  it("markMonitoring converges when already monitoring", () => {
    const s = state({ recommendations: [recommendation("monitoring")] });
    const out = markMonitoring(s, INTENT);
    expect(out.applied).toBe(true);
    expect(out.reason).toBe("already_monitoring");
  });

  it("duplicate invocation converges to exactly one applied record (no duplicate rule)", () => {
    const s1 = beginApply(state(), INTENT);
    const s2 = markApplied(s1.next!, INTENT, "rule-1");
    const s3 = markMonitoring(s2.next!, INTENT);
    // Re-run the whole chain on the converged state: no-op at every step.
    const again1 = beginApply(s3.next!, INTENT);
    const again2 = markApplied(again1.next!, INTENT, "rule-1");
    const again3 = markMonitoring(again2.next!, INTENT);
    expect(again1.reason).toBe("already_applying");
    expect(again2.reason).toBe("already_applied");
    expect(again3.reason).toBe("already_monitoring");
    expect(again3.next!.appliedRules).toHaveLength(1);
    expect(again3.next!.recommendations[0].status).toBe("monitoring");
  });
});