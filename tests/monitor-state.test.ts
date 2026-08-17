import { describe, expect, it } from "vitest";

import {
  markRolledBack,
  recordCheckpointOutcome,
} from "../src/shared/monitor-state.ts";
import type { Recommendation, ZoneAgentState } from "../src/shared/types.ts";

const ZONE = "zone-abc";
const REC_ID = "R-1042";
const NOW = new Date("2026-08-15T00:00:00Z");

function recommendation(status: Recommendation["status"] = "monitoring"): Recommendation {
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
    cloudflareRuleId: "cf-rule-1",
  };
}

function state(overrides: Partial<ZoneAgentState> = {}): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId: ZONE,
    recommendations: [recommendation()],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [
      {
        recommendationId: REC_ID,
        cloudflareRuleId: "cf-rule-1",
        mutationId: "m-abcdef1234567890",
        payloadHash: "aaaa",
        appliedAt: "2026-08-14T00:00:00Z",
        status: "applied",
      },
    ],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    ...overrides,
  };
}

const INTENT = { recommendationId: REC_ID, now: NOW };

describe("recordCheckpointOutcome", () => {
  it("records a concise checkpoint outcome without mutating the recommendation", () => {
    const record = {
      recommendationId: REC_ID,
      checkpoint: "24h" as const,
      outcomeKey: `outcomes/${ZONE}/R-1042/24h.json`,
      endDay: "2026-08-14",
      generatedAt: NOW.toISOString(),
      fullCoverage: true,
    };
    const out = recordCheckpointOutcome(state(), record);
    expect(out.applied).toBe(true);
    expect(out.next?.monitoringRecords).toHaveLength(1);
    // The immutable recommendation mutation fields are untouched.
    expect(out.next?.recommendations[0].expression).toBe("expr");
    expect(out.next?.recommendations[0].status).toBe("monitoring");
  });

  it("is idempotent for the same checkpoint", () => {
    const record = {
      recommendationId: REC_ID,
      checkpoint: "24h" as const,
      outcomeKey: `outcomes/${ZONE}/R-1042/24h.json`,
      endDay: "2026-08-14",
      generatedAt: NOW.toISOString(),
      fullCoverage: true,
    };
    const once = recordCheckpointOutcome(state(), record).next!;
    const twice = recordCheckpointOutcome(once, record);
    expect(twice.applied).toBe(true);
    expect(twice.reason).toBe("already_recorded");
    expect(twice.next?.monitoringRecords).toHaveLength(1);
  });
});

describe("rollback lifecycle reducers", () => {
  it("transitions a persisted rollback_recommended → rolled_back", () => {
    const s = state({ recommendations: [recommendation("rollback_recommended")] });
    const rolled = markRolledBack(s, INTENT);
    expect(rolled.applied).toBe(true);
    expect(rolled.next!.recommendations[0].status).toBe("rolled_back");
    expect(rolled.next!.appliedRules[0].status).toBe("rolled_back");
    expect(rolled.next!.recentOutcomes[0].status).toBe("rolled_back");
    expect(rolled.next!.rollbackOutcomes![0].status).toBe("rolled_back");
  });

  it("refuses rolled_back from a non-rollbackable state (applied/monitoring/rollback_recommended only)", () => {
    const s = state({ recommendations: [recommendation("pending_approval")] });
    const out = markRolledBack(s, INTENT);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain("not_rollbackable");
  });

  it("transitions applied → rolled_back", () => {
    const s = state({ recommendations: [recommendation("applied")] });
    const out = markRolledBack(s, INTENT);
    expect(out.applied).toBe(true);
    expect(out.next!.recommendations[0].status).toBe("rolled_back");
    expect(out.next!.appliedRules[0].status).toBe("rolled_back");
  });

  it("transitions monitoring → rolled_back", () => {
    const out = markRolledBack(state(), INTENT);
    expect(out.applied).toBe(true);
    expect(out.next!.recommendations[0].status).toBe("rolled_back");
    expect(out.next!.appliedRules[0].status).toBe("rolled_back");
  });

  it("is idempotent on duplicate rolled_back deliveries from a persisted rollback_recommended state", () => {
    const rec = state({ recommendations: [recommendation("rollback_recommended")] });
    const rolled = markRolledBack(rec, INTENT).next!;
    expect(rolled.recommendations[0].status).toBe("rolled_back");
    const rolledAgain = markRolledBack(rolled, INTENT);
    expect(rolledAgain.reason).toBe("already_rolled_back");
    expect(rolledAgain.next!.rollbackOutcomes).toHaveLength(1);
  });

  it("marks an unknown recommendation as unknown", () => {
    expect(markRolledBack(state(), { recommendationId: "R-9999", now: NOW }).reason).toBe("unknown_recommendation");
  });
});
