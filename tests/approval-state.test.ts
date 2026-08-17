import { describe, expect, it } from "vitest";

import {
  applyApprovalTransition,
  tokenForRecommendation,
} from "../src/shared/approval-state.ts";
import type { ZoneAgentState, ApprovalTokenRecord, Recommendation } from "../src/shared/types.ts";

const ZONE = "zone-abc";
const TOKEN_ID = "tok-1111111111111111";
const REC_ID = "R-1042";

function recommendation(status: Recommendation["status"] = "pending_approval"): Recommendation {
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

function tokenRecord(overrides: Partial<ApprovalTokenRecord> = {}): ApprovalTokenRecord {
  return {
    tokenId: TOKEN_ID,
    recommendationId: REC_ID,
    zoneId: ZONE,
    decision: "APPLY",
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    payload: JSON.stringify({ recommendationId: REC_ID, zoneId: ZONE }),
    signedToken: "token.payload",
    ...overrides,
  };
}

function state(overrides: Partial<ZoneAgentState> = {}): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId: ZONE,
    recommendations: [recommendation()],
    approvalTokens: [tokenRecord()],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    ...overrides,
  };
}

const NOW = new Date("2026-08-15T00:00:00Z");

describe("approval state machine", () => {
  it("transitions pending_approval → approved and consumes the token atomically", () => {
    const outcome = applyApprovalTransition(state(), {
      recommendationId: REC_ID,
      approvalTokenId: TOKEN_ID,
      now: NOW,
      consumedBy: "submission-1",
    });
    expect(outcome.applied).toBe(true);
    const next = outcome.next!;
    const rec = next.recommendations.find((r) => r.id === REC_ID)!;
    expect(rec.status).toBe("approved");
    const tok = next.approvalTokens.find((t) => t.tokenId === TOKEN_ID)!;
    expect(tok.consumedAt).toBe(NOW.toISOString());
    expect(tok.consumedBy).toBe("submission-1");
    expect(next.approvedRecords).toHaveLength(1);
    expect(next.approvedRecords[0].approvalTokenId).toBe(TOKEN_ID);
    expect(next.approvedRecords[0].mutationId).toBe("m-abcdef1234567890");
  });

  it("converges on duplicate deliveries: second attempt is a no-op", () => {
    const first = applyApprovalTransition(state(), { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    const second = applyApprovalTransition(first.next!, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("token_already_consumed");
    expect(second.next).toBeUndefined();
    // Exactly one approved record exists after both deliveries.
    expect(second.next ?? first.next!.approvedRecords).toHaveLength(1);
  });

  it("rejects an unknown token id", () => {
    const outcome = applyApprovalTransition(state(), { recommendationId: REC_ID, approvalTokenId: "nope", now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("unknown_approval_token");
  });

  it("rejects a token bound to a different recommendation", () => {
    const s = state({ approvalTokens: [tokenRecord({ recommendationId: "R-9999" })] });
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("token_recommendation_mismatch");
  });

  it("rejects a token bound to a different zone", () => {
    const s = state({ approvalTokens: [tokenRecord({ zoneId: "zone-other" })] });
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("token_zone_mismatch");
  });

  it("rejects an expired token", () => {
    const s = state({ approvalTokens: [tokenRecord({ expiresAt: "2020-01-01T00:00:00Z" })] });
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("token_expired");
  });

  it("rejects when the recommendation is not pending_approval", () => {
    const s = state({ recommendations: [recommendation("approved")] });
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("recommendation_not_pending_approval");
  });

  it("rejects a token payload mismatch (defense in depth)", () => {
    const s = state({
      approvalTokens: [tokenRecord({ payload: JSON.stringify({ recommendationId: "R-9999", zoneId: ZONE }) })],
    });
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("token_payload_mismatch");
  });

  it("rejects an expired recommendation", () => {
    const s = state({ recommendations: [recommendation("pending_approval")] });
    s.recommendations[0].expiresAt = "2020-01-01T00:00:00Z";
    const outcome = applyApprovalTransition(s, { recommendationId: REC_ID, approvalTokenId: TOKEN_ID, now: NOW });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("recommendation_not_pending_approval");
  });
});

describe("tokenForRecommendation", () => {
  it("returns the unconsumed token for a recommendation", () => {
    expect(tokenForRecommendation(state(), REC_ID)?.tokenId).toBe(TOKEN_ID);
  });
  it("returns undefined once consumed", () => {
    const consumed = state();
    consumed.approvalTokens[0].consumedAt = NOW.toISOString();
    expect(tokenForRecommendation(consumed, REC_ID)).toBeUndefined();
  });
});