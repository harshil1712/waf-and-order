/**
 * Deterministic application policy for the guarded WAF apply tool.
 *
 * The apply tool re-validates every recommendation against this policy
 * immediately before mutating Cloudflare. It is a pure, unit-testable module:
 * given a stored recommendation and the current zone state, it decides whether
 * application is permitted. Limits are simple constants — not a policy service.
 */

import type { Recommendation, ZoneAgentState } from "./types.ts";
import { mutationIdOf, payloadHashOf, RECOMMENDATION_PHASE } from "./recommendation.ts";

/** Maximum accepted WAF-expression length (chars). */
const MAX_EXPRESSION_LENGTH = 2000;

/** Bounded blast radius: max ASNs in `ip.src.asnum in {...}`. */
const MAX_ASN_SET_SIZE = 20;
/** Bounded blast radius: max path literals in `http.request.uri.path in {...}`. */
const MAX_PATH_SET_SIZE = 20;
/** Bounded blast radius: max total set elements across all `in {...}` sets. */
const MAX_TOTAL_SET_SIZE = 40;

/** Cap on concurrently applied (or being applied) Managed Challenge rules. */
export const MAX_CONCURRENT_MANAGED_CHALLENGE_RULES = 5;

/**
 * Derive the unique stable rule reference deterministically from the
 * recommendation id. The model cannot choose it; it is a
 * recovery aid locating a rule when the recorded Cloudflare rule id is
 * unavailable, and is never the primary mutation key.
 */
export function stableRuleRefFor(recommendationId: string): string {
  return `botguard-${recommendationId}`;
}

/** Result of conservative expression validation. */
export interface ExpressionValidation {
  valid: boolean;
  reasons: string[];
}

/** The bounded set fields that may positively scope an applyable expression. */
const BOUNDED_SET_FIELDS = new Set(["ip.src.asnum", "http.request.uri.path"]);

/**
 * The only allowed negation: the exact verified-crawler safety clause. It is
 * required so verified (declared) crawlers are never challenged.
 */
const BOT_SAFETY_CLAUSE = "not cf.client.bot";

/** Match an `in { ... }` set and capture the field it scopes. */
const IN_SET_RE = /([a-z0-9_.]+)\s+in\s*\{([^}]*)\}/g;

/** Extract `{field, elements}` pairs from every `in {...}` set literal. */
export function parseInSets(expression: string): { field: string; elements: string[] }[] {
  const sets: { field: string; elements: string[] }[] = [];
  let match: RegExpExecArray | null;
  IN_SET_RE.lastIndex = 0;
  while ((match = IN_SET_RE.exec(expression)) !== null) {
    const field = match[1];
    const elements = match[2]
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    sets.push({ field, elements });
  }
  return sets;
}

/**
 * Replace string literals with `""` so structural scanning for operators
 * (`and`/`or`/`not`) and set literals does not trip on text that happens to
 * contain those words (e.g. a path `/forum/` or fake `in {...}` text inside a
 * quoted literal). Repeated quoted elements are preserved as repeated `""`
 * tokens, which is sufficient for bounded-set counting.
 */
function maskStringLiterals(expression: string): string {
  return expression.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Conservative WAF-expression policy.
 *
 * Structural checks reject injection and multi-line payloads; scope checks
 * reject match-all/broad expressions and require at least one non-empty
 * positive bounded set predicate on `ip.src.asnum` or `http.request.uri.path`;
 * set-size checks bound the blast radius. Negation is only permitted for the
 * exact `not cf.client.bot` verified-crawler safety clause, boolean OR is
 * rejected (it can broaden around the bounded predicate), and `any()`/`all()`
 * helpers are rejected as unbounded. Other clauses may only narrow via AND.
 * The expression is treated as attacker/model-supplied untrusted input and is
 * validated deterministically here — never passed through to Cloudflare without
 * this gate.
 */
export function validateExpressionForApply(expression: string): ExpressionValidation {
  const reasons: string[] = [];

  if (!expression || expression.trim().length === 0) {
    return { valid: false, reasons: ["empty expression"] };
  }

  // Structural: single-line, no control characters, no obvious injection.
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    reasons.push("expression exceeds maximum length");
  }
  if (/[\r\n\u0000-\u001f]/.test(expression)) {
    reasons.push("expression contains control characters or line breaks");
  }
  if (/[;`$]/.test(expression)) {
    reasons.push("expression contains shell or injection metacharacters");
  }

  const masked = maskStringLiterals(expression);
  const lower = masked.toLowerCase();

  // Scope: reject a match-all / true literal.
  if (/^\s*true\s*$/.test(lower)) {
    reasons.push("expression matches all traffic (match-all scope)");
  }

  // Reject boolean OR: it could broaden scope around the bounded predicate.
  if (/\bor\b/.test(masked)) {
    reasons.push("expression uses boolean OR, which can broaden scope");
  }

  // Reject unbounded any()/all() helpers (with a leading word boundary).
  if (/\bany\(|\ball\(/.test(masked)) {
    reasons.push("expression uses an unbounded any()/all() helper");
  }

  // Negation: only the exact verified-crawler safety clause is allowed.
  const hasBotSafety = new RegExp(`\\b${BOT_SAFETY_CLAUSE}\\b`).test(masked);
  if (/\bnot\b/.test(masked.replace(new RegExp(`\\b${BOT_SAFETY_CLAUSE}\\b`, "g"), "true"))) {
    reasons.push("expression uses negation other than the 'not cf.client.bot' safety clause");
  }
  if (!hasBotSafety) {
    reasons.push("expression must include 'not cf.client.bot' to preserve verified crawlers");
  }

  // Blast radius + bounded-set requirement. A set that is negated or part of an
  // OR is already rejected above; here we require at least one non-empty
  // positive bounded set predicate on an allowed field. Parse the masked
  // expression so set literals inside quoted strings are not counted.
  const sets = parseInSets(masked);
  let totalElements = 0;
  let hasPositiveBounded = false;
  for (const { field, elements } of sets) {
    totalElements += elements.length;
    if (field === "ip.src.asnum" && elements.length > MAX_ASN_SET_SIZE) {
      reasons.push(`ASN set exceeds bounded blast radius (${elements.length} > ${MAX_ASN_SET_SIZE})`);
    }
    if (field === "http.request.uri.path" && elements.length > MAX_PATH_SET_SIZE) {
      reasons.push(`path set exceeds bounded blast radius (${elements.length} > ${MAX_PATH_SET_SIZE})`);
    }
    if (field === "ip.geoip.country") {
      reasons.push("country-based restriction is high-risk / report-only and not applyable");
    }
    if (BOUNDED_SET_FIELDS.has(field)) {
      if (elements.length === 0) {
        reasons.push(`${field} bounded set must contain at least one element`);
      } else {
        hasPositiveBounded = true;
      }
    }
  }
  if (!hasPositiveBounded) {
    reasons.push(
      "expression must include at least one non-empty positive bounded set predicate on ip.src.asnum or http.request.uri.path",
    );
  }
  if (totalElements > MAX_TOTAL_SET_SIZE) {
    reasons.push(`total set size exceeds bounded blast radius (${totalElements} > ${MAX_TOTAL_SET_SIZE})`);
  }

  return { valid: reasons.length === 0, reasons };
}

/** The email-approval risk band: only low/medium are applyable. */
function isInApprovalRiskBand(risk: Recommendation["risk"]): boolean {
  return risk === "low" || risk === "medium";
}

/** Count concurrently active (applying/applied/monitoring) Managed Challenge rules. */
export function countActiveManagedChallengeRules(state: ZoneAgentState): number {
  return state.recommendations.filter(
    (r) => r.status === "applying" || r.status === "applied" || r.status === "monitoring",
  ).length;
}

/**
 * Deterministic full application authorization. Returns the exact mutation to
 * submit and the authoritative rule reference, or reasons why application is
 * refused. This is the gate that binds application to the trusted persisted
 * recommendation and approval — the model supplies only the two ids.
 */
export interface ApplyAuthorization {
  ok: boolean;
  reasons?: string[];
  /** The exact rule payload to submit (loaded from trusted persistent state). */
  rule?: {
    expression: string;
    action: "managed_challenge";
    description: string;
    ref: string;
    action_parameters: Record<string, string>;
  };
  /** Recomputed canonical payload hash and mutation id for verification. */
  payloadHash?: string;
  mutationId?: string;
}

/** Verify a recommendation against the full application policy. */
export function authorizeApplication(
  state: ZoneAgentState,
  recommendationId: string,
  approvalTokenId: string,
  now: Date,
  config: { zoneId: string; rulesetId: string; phase: string },
): ApplyAuthorization {
  const reasons: string[] = [];
  const rec = state.recommendations.find((r) => r.id === recommendationId);

  if (!rec) {
    return { ok: false, reasons: ["unknown_recommendation"] };
  }
  if (rec.status !== "approved") {
    reasons.push(`recommendation status is ${rec.status}, not approved`);
  }
  if (new Date(rec.expiresAt).getTime() <= now.getTime()) {
    reasons.push("recommendation expired");
  }

  // Target binding: the stored ruleset/phase/zone must equal the trusted config.
  if (rec.rulesetId !== config.rulesetId) {
    reasons.push("stored ruleset id does not match trusted target");
  }
  if (rec.phase !== config.phase) {
    reasons.push("stored phase does not match trusted target");
  }
  if (rec.zoneId !== config.zoneId) {
    reasons.push("stored zone does not match trusted target");
  }

  // Approved record must be the exact-bound, consumed approval for this token.
  const approved = state.approvedRecords.find(
    (a) =>
      a.recommendationId === recommendationId &&
      a.approvalTokenId === approvalTokenId &&
      a.status === "approved",
  );
  if (!approved) {
    reasons.push("no matching exact-bound approved record for the supplied token");
  }
  const token = state.approvalTokens.find((t) => t.tokenId === approvalTokenId);
  if (!token) {
    reasons.push("unknown approval token");
  } else {
    if (!token.consumedAt) reasons.push("approval token not consumed");
    if (token.recommendationId !== recommendationId) reasons.push("token bound to a different recommendation");
    if (token.zoneId !== config.zoneId) reasons.push("token bound to a different zone");
  }

  // Recompute the payload hash and mutation id against the stored values.
  const recomputedHash = payloadHashOf({
    zoneId: rec.zoneId,
    phase: rec.phase,
    rulesetId: rec.rulesetId,
    action: rec.action,
    expression: rec.expression,
    description: rec.description,
    stableRuleRef: rec.stableRuleRef,
    actionParameters: {},
  });
  if (recomputedHash !== rec.payloadHash) reasons.push("recomputed payloadHash does not match stored value");
  const recomputedMutationId = mutationIdOf({
    zoneId: rec.zoneId,
    phase: rec.phase,
    rulesetId: rec.rulesetId,
    action: rec.action,
    expression: rec.expression,
    description: rec.description,
    stableRuleRef: rec.stableRuleRef,
    actionParameters: {},
  });
  if (recomputedMutationId !== rec.mutationId) reasons.push("recomputed mutationId does not match stored value");

  // Risk band + conservative expression policy + blast radius.
  if (!isInApprovalRiskBand(rec.risk)) reasons.push("recommendation risk is outside the email-approval band");
  const exprCheck = validateExpressionForApply(rec.expression);
  if (!exprCheck.valid) reasons.push(...exprCheck.reasons.map((r) => `expression: ${r}`));

  // Max concurrent Managed Challenge rules.
  const active = countActiveManagedChallengeRules(state);
  if (active >= MAX_CONCURRENT_MANAGED_CHALLENGE_RULES) {
    reasons.push(
      `concurrent Managed Challenge rule limit reached (${active} >= ${MAX_CONCURRENT_MANAGED_CHALLENGE_RULES})`,
    );
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    rule: {
      expression: rec.expression,
      action: "managed_challenge",
      description: rec.description,
      ref: rec.stableRuleRef,
      action_parameters: {},
    },
    payloadHash: recomputedHash,
    mutationId: recomputedMutationId,
  };
}