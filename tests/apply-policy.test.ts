import { describe, expect, it } from "vitest";

import {
  authorizeApplication,
  countActiveManagedChallengeRules,
  MAX_CONCURRENT_MANAGED_CHALLENGE_RULES,
  parseInSets,
  stableRuleRefFor,
  validateExpressionForApply,
} from "../src/shared/apply-policy.ts";
import { mutationIdOf, payloadHashOf, RECOMMENDATION_PHASE } from "../src/shared/recommendation.ts";
import type { Recommendation, ZoneAgentState } from "../src/shared/types.ts";

const ZONE = "zone-abc";
const RULESET_ID = "abcdefabcdefabcdefabcdefabcdefab";
const RULESET_VERSION = "2";
const PHASE = "http_request_firewall_custom";
const REC_ID = "R-1042";
const TOKEN_ID = "tok-1111111111111111";
const NOW = new Date("2026-08-15T00:00:00Z");

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  const base = {
    id: REC_ID,
    findingId: "F-1",
    zoneId: ZONE,
    createdAt: "2026-08-13T00:00:00Z",
    expiresAt: "2026-08-20T00:00:00Z",
    status: "approved" as const,
    type: "datacenter_scraping",
    action: "managed_challenge" as const,
    phase: PHASE,
    expression: "(ip.src.asnum in {16509 14618}) and not cf.client.bot",
    description: "desc",
    evidence: [{ label: "e", value: "v" }],
    confidence: 0.91,
    risk: "medium" as const,
    expectedImpact: { requestRatePerDay: 10, likelyLegitimateExposure: "~0.3%", blastRadius: "bounded" as const },
    rulesetId: RULESET_ID,
    rulesetVersion: RULESET_VERSION,
    stableRuleRef: stableRuleRefFor(REC_ID),
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
status: "approved" as const,
      },
    ],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    ...overrides,
  };
}

const CONFIG = { zoneId: ZONE, rulesetId: RULESET_ID, phase: PHASE };

describe("stableRuleRefFor", () => {
  it("derives the stable reference deterministically from the recommendation id", () => {
    expect(stableRuleRefFor("R-1042")).toBe("botguard-R-1042");
    expect(stableRuleRefFor("R-1042")).toBe(stableRuleRefFor("R-1042"));
    expect(stableRuleRefFor("R-1")).toBe("botguard-R-1");
  });
});

describe("parseInSets", () => {
  it("extracts field + elements from every in-set literal", () => {
    const sets = parseInSets("(ip.src.asnum in {16509 14618}) and (http.request.uri.path in {\"/a\" \"/b\"})");
    expect(sets).toContainEqual({ field: "ip.src.asnum", elements: ["16509", "14618"] });
    expect(sets).toContainEqual({ field: "http.request.uri.path", elements: ["\"/a\"", "\"/b\""] });
  });
});

describe("validateExpressionForApply", () => {
  it("accepts a bounded, concrete scoping expression", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {16509 14618}) and not cf.client.bot");
    expect(r.valid).toBe(true);
  });

  it("rejects an empty expression", () => {
    expect(validateExpressionForApply("").valid).toBe(false);
    expect(validateExpressionForApply("   ").valid).toBe(false);
  });

  it("rejects a match-all / broad true literal", () => {
    const r = validateExpressionForApply("true");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("match-all");
  });

  it("rejects an expression with no bounded scoping field", () => {
    const r = validateExpressionForApply("http.request.body eq \"x\"");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain(
      "at least one non-empty positive bounded set predicate on ip.src.asnum or http.request.uri.path",
    );
  });

  it("rejects injection metacharacters", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {16509}); drop table;");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("injection");
  });

  it("rejects multi-line / control characters", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {16509})\nand true");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("line breaks");
  });

  it("rejects an oversized ASN set (bounded blast radius)", () => {
    const big = Array.from({ length: 21 }, (_, i) => String(10000 + i)).join(" ");
    const r = validateExpressionForApply(`ip.src.asnum in {${big}} and not cf.client.bot`);
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("ASN set exceeds bounded blast radius");
  });

  it("rejects an oversized total set size across fields", () => {
    const asns = Array.from({ length: 20 }, (_, i) => String(20000 + i)).join(" ");
    const paths = Array.from({ length: 20 }, (_, i) => `"p${i}"`).join(" ");
    const uas = Array.from({ length: 1 }, () => `"ua0"`).join(" ");
    const r = validateExpressionForApply(
      `(ip.src.asnum in {${asns}}) and (http.request.uri.path in {${paths}}) and (http.user_agent in {${uas}}) and not cf.client.bot`,
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("total set size exceeds bounded blast radius");
  });

  it("rejects a bare 'not cf.client.bot' with no bounded set predicate", () => {
    const r = validateExpressionForApply("not cf.client.bot");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain(
      "at least one non-empty positive bounded set predicate on ip.src.asnum or http.request.uri.path",
    );
  });

  it("rejects a threat-score-threshold-only expression (no bounded set predicate)", () => {
    const r = validateExpressionForApply("cf.threat_score gt 5 and not cf.client.bot");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain(
      "at least one non-empty positive bounded set predicate on ip.src.asnum or http.request.uri.path",
    );
  });

  it("rejects a country-based restriction as high-risk / report-only", () => {
    const r = validateExpressionForApply("(ip.geoip.country in {\"US\"}) and not cf.client.bot");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("country-based restriction is high-risk / report-only and not applyable");
  });

  it("rejects boolean OR which can broaden scope around the bounded predicate", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {16509}) or (http.host eq \"other\") and not cf.client.bot");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("boolean OR");
  });

  it("rejects negation other than the 'not cf.client.bot' safety clause", () => {
    const r = validateExpressionForApply(
      "(ip.src.asnum in {16509}) and not (http.host eq \"x\") and not cf.client.bot",
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("uses negation other than the 'not cf.client.bot' safety clause");
  });

  it("rejects a negated bounded set (non-bot negation)", () => {
    const r = validateExpressionForApply(
      "(not (ip.src.asnum in {16509})) and not cf.client.bot",
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("uses negation other than the 'not cf.client.bot' safety clause");
  });

  it("rejects an empty bounded set predicate", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {}) and not cf.client.bot");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("bounded set must contain at least one element");
  });

  it("rejects unbounded any()/all() helpers", () => {
    const anyExpr = validateExpressionForApply("(any(ip.src.asnum in {16509})) and not cf.client.bot");
    const allExpr = validateExpressionForApply("(all(ip.src.asnum in {16509})) and not cf.client.bot");
    expect(anyExpr.valid).toBe(false);
    expect(allExpr.valid).toBe(false);
    expect(anyExpr.reasons.join(";")).toContain("unbounded any()/all() helper");
  });

  it("requires 'not cf.client.bot' to preserve verified crawlers", () => {
    const r = validateExpressionForApply("(ip.src.asnum in {16509 14618})");
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain("must include 'not cf.client.bot'");
  });

  it("accepts a valid conjunction of ASN and path bounded sets", () => {
    const r = validateExpressionForApply(
      "(ip.src.asnum in {16509 14618}) and (http.request.uri.path in {\"/a\" \"/b\"}) and not cf.client.bot",
    );
    expect(r.valid).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("accepts a positive narrowing AND clause alongside the bounded set", () => {
    const r = validateExpressionForApply(
      "(ip.src.asnum in {16509}) and (http.host eq \"example.com\") and not cf.client.bot",
    );
    expect(r.valid).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("does not mistake 'or'/'and' inside a string literal for boolean operators", () => {
    const r = validateExpressionForApply(
      "(http.request.uri.path in {\"/forum\" \"/dashboard\"}) and not cf.client.bot",
    );
    expect(r.valid).toBe(true);
  });

  it("does not parse fake set text inside a quoted string literal as a bounded predicate", () => {
    const r = validateExpressionForApply(
      "http.host eq \"ip.src.asnum in {16509}\" and not cf.client.bot",
    );
    expect(r.valid).toBe(false);
    expect(r.reasons.join(";")).toContain(
      "at least one non-empty positive bounded set predicate on ip.src.asnum or http.request.uri.path",
    );
  });
});

describe("authorizeApplication", () => {
  it("authorizes a fully-approved, bounded, in-band recommendation", () => {
    const auth = authorizeApplication(state(), REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(true);
    expect(auth.rule?.ref).toBe("botguard-R-1042");
    expect(auth.rule?.action).toBe("managed_challenge");
  });

  it("rejects a recommendation that is not approved", () => {
    const s = state({ recommendations: [recommendation({ status: "pending_approval" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("not approved");
  });

  it("rejects an expired recommendation", () => {
    const s = state({ recommendations: [recommendation({ expiresAt: "2020-01-01T00:00:00Z" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("expired");
  });

  it("rejects a wrong approval token (no matching exact-bound approved record)", () => {
    const auth = authorizeApplication(state(), REC_ID, "tok-wrong", NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("no matching exact-bound approved record");
  });

  it("rejects an unconsumed approval token", () => {
    const s = state();
    s.approvalTokens[0].consumedAt = undefined;
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("approval token not consumed");
  });

  it("rejects a token bound to a different recommendation", () => {
    const s = state();
    s.approvalTokens[0].recommendationId = "R-9999";
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("token bound to a different recommendation");
  });

  it("rejects when the stored ruleset id differs from the trusted target", () => {
    const s = state({ recommendations: [recommendation({ rulesetId: "other-ruleset" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("stored ruleset id does not match trusted target");
  });

  it("rejects when the stored phase differs from the trusted target", () => {
    const s = state({ recommendations: [recommendation({ phase: "http_request_firewall_managed" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("stored phase does not match trusted target");
  });

  it("rejects a payloadHash mismatch (recomputed hash differs from stored)", () => {
    const s = state({ recommendations: [recommendation({ payloadHash: "deadbeef" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("recomputed payloadHash does not match stored value");
  });

  it("rejects a mutationId mismatch", () => {
    const s = state({ recommendations: [recommendation({ mutationId: "m-wrong" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("recomputed mutationId does not match stored value");
  });

  it("rejects high-risk recommendations (outside the email-approval band)", () => {
    const s = state({ recommendations: [recommendation({ risk: "high" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("risk is outside the email-approval band");
  });

  it("rejects a broad-scope expression (conservative policy at apply time)", () => {
    const s = state({ recommendations: [recommendation({ expression: "true" })] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("expression: ");
  });

  it("enforces the max concurrent Managed Challenge rules limit", () => {
    const recs = Array.from({ length: MAX_CONCURRENT_MANAGED_CHALLENGE_RULES }, (_, i) =>
      recommendation({ id: `R-${i + 1}`, status: "applied" as const }),
    );
    // Include the target rec as already-approved (not counted as active).
    const s = state({ recommendations: [...recs, recommendation()] });
    const auth = authorizeApplication(s, REC_ID, TOKEN_ID, NOW, CONFIG);
    expect(auth.ok).toBe(false);
    expect(auth.reasons!.join(";")).toContain("concurrent Managed Challenge rule limit reached");
  });
});

describe("countActiveManagedChallengeRules", () => {
  it("counts applying/applied/monitoring but not approved or rolled back", () => {
    const s = state({
      recommendations: [
        recommendation({ id: "R-1", status: "applying" }),
        recommendation({ id: "R-2", status: "applied" }),
        recommendation({ id: "R-3", status: "monitoring" }),
        recommendation({ id: "R-4", status: "approved" }),
        recommendation({ id: "R-5", status: "rolled_back" }),
      ],
    });
    expect(countActiveManagedChallengeRules(s)).toBe(3);
  });
});
