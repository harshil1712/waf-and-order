/**
 * Immutable recommendation model + deterministic validation/risk policy.
 *
 * A recommendation is created once and never mutated. Every mutation field
 * (zone, ruleset id, phase, action, expression, action parameters, description,
 * stable rule reference) is folded into a canonical {@link payloadHash} over
 * the exact payload submitted to the single-rule endpoint. The live
 * `rulesetVersion` is deliberately excluded from the hash.
 * If any mutation field changes, a new recommendation `id` and `mutationId`
 * are minted and fresh approval is required; `findingId` may stay stable.
 */

import { sha256 } from "./canonical.ts";

/** The only WAF action the MVP recommends. */
export type RecommendationAction = "managed_challenge";

/** Recommendation lifecycle status. */
export type RecommendationStatus =
  | "pending_approval"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "expired"
  | "failed"
  | "monitoring"
  | "rollback_recommended"
  | "rolled_back"
  | "completed";

/**
 * The immutable recommendation model. An approved
 * recommendation is never mutated; a changed mutation payload is a new
 * recommendation. Only `status`, `cloudflareRuleId`, and lifecycle fields
 * transition; the mutation payload fields are fixed.
 */
export interface Recommendation {
  /** Approval-facing revision id, e.g. `R-1042`. */
  id: string;
  /** Stable link across repeated observations of the same finding. */
  findingId: string;
  zoneId: string;
  createdAt: string;
  expiresAt: string;
  status: RecommendationStatus;
  type: string;
  action: RecommendationAction;
  /** Ruleset phase, e.g. `http_request_firewall_custom`. */
  phase: string;
  /** The exact WAF expression to submit. */
  expression: string;
  description: string;
  evidence: Evidence[];
  confidence: number;
  risk: RiskLevel;
  expectedImpact: ExpectedImpact;
  /** The target ruleset id, resolved before approval. */
  rulesetId: string;
  /**
   * Live ruleset version recorded as context for rollback/drift review. NOT
   * part of the submitted-payload hash.
   */
  rulesetVersion: string;
  /** Identifies the exact immutable WAF payload; changes with any mutation field. */
  mutationId: string;
  /** Canonical hash over the exact mutation payload, excluding rulesetVersion. */
  payloadHash: string;
  /** Recovery aid locating a rule when the Cloudflare rule id is unavailable. */
  stableRuleRef: string;
  cloudflareRuleId?: string;
}

/** Ruleset phase targeted by the MVP custom-rule recommendation. */
export const RECOMMENDATION_PHASE = "http_request_firewall_custom";

/** The deterministic risk classification. */
export type RiskLevel = "low" | "medium" | "high";

/**
 * Expected impact of applying a recommendation. The
 * "likely legitimate traffic exposure" figure is a labeled heuristic estimate,
 * never a measured human count.
 */
export interface ExpectedImpact {
  requestRatePerDay: number;
  /** Labeled heuristic: likely legitimate traffic exposure, not human traffic. */
  likelyLegitimateExposure: string;
  blastRadius: "bounded" | "broad";
}

/** A single observation supporting a recommendation. */
export interface Evidence {
  label: string;
  value: string;
}

/** Everything that determines the exact WAF rule submitted. */
export interface ManagedChallengeMutation {
  zoneId: string;
  phase: string;
  rulesetId: string;
  action: RecommendationAction;
  expression: string;
  description: string;
  stableRuleRef: string;
  /**
   * Optional action parameters (e.g. Managed Challenge UI settings). Bounded
   * Managed Challenge typically carries none; kept in the payload for hash
   * completeness.
   */
  actionParameters: Record<string, string>;
}

/**
 * Build the canonical object whose serialization is the {@link payloadHash}.
 * Deliberately excludes `rulesetVersion`: version drift must
 * not gate application, so the hash covers only what is actually written.
 */
export function mutationPayload(m: ManagedChallengeMutation): unknown {
  return {
    zoneId: m.zoneId,
    phase: m.phase,
    rulesetId: m.rulesetId,
    action: m.action,
    expression: m.expression,
    actionParameters: m.actionParameters,
    description: m.description,
    stableRuleRef: m.stableRuleRef,
  };
}

/**
 * Deterministic canonical payload hash. Two recommendations with identical
 * mutation fields hash identically; a single mutation field change flips the
 * hash and requires a new recommendation + fresh approval.
 */
export function payloadHashOf(m: ManagedChallengeMutation): string {
  return sha256(mutationPayload(m));
}

/** A stable mutation id derived from the canonical payload hash. */
export function mutationIdOf(m: ManagedChallengeMutation): string {
  return `m-${payloadHashOf(m).slice(0, 16)}`;
}

/** Minimum confidence (0..1) for an email-approvable recommendation. */
const MIN_APPROVAL_CONFIDENCE = 0.8;
/** Default recommendation validity window, in milliseconds. */
export const DEFAULT_RECOMMENDATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deterministic risk policy. Only bounded Managed Challenge
 * recommendations are email-approvable in the MVP. A "broad" blast radius or a
 * prohibited scope is not recommendable.
 */
export function classifyRisk(
  risk: RiskLevel,
  blastRadius: ExpectedImpact["blastRadius"],
): { risk: RiskLevel; approvable: boolean } {
  if (risk === "high") {
    return { risk, approvable: false };
  }
  if (blastRadius !== "bounded") {
    return { risk, approvable: false };
  }
  return { risk, approvable: true };
}

/** Deterministic structural validation of a candidate recommendation. */
export interface RecommendationValidation {
  valid: boolean;
  reasons: string[];
}

/** Validate a fully-formed recommendation before it is persisted. */
export function validateRecommendation(
  r: Pick<
    Recommendation,
    | "id"
    | "zoneId"
    | "phase"
    | "action"
    | "expression"
    | "description"
    | "confidence"
    | "risk"
    | "expectedImpact"
    | "rulesetId"
    | "stableRuleRef"
    | "mutationId"
    | "payloadHash"
    | "expiresAt"
  >,
  now?: Date,
  expectedPhase: string = RECOMMENDATION_PHASE,
): RecommendationValidation {
  const reasons: string[] = [];
  const reference = now ?? new Date();
  if (!r.id || !/^R-\d+$/.test(r.id)) reasons.push("invalid id (expected R-<n>)");
  if (!r.zoneId) reasons.push("missing zoneId");
  if (r.phase !== expectedPhase) reasons.push("unsupported phase");
  if (r.action !== "managed_challenge") reasons.push("unsupported action");
  if (!r.expression || r.expression.length === 0) reasons.push("missing expression");
  if (!r.rulesetId) reasons.push("missing rulesetId");
  if (!r.stableRuleRef) reasons.push("missing stableRuleRef");
  if (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1) {
    reasons.push("confidence out of range (0..1)");
  } else if (r.confidence < MIN_APPROVAL_CONFIDENCE) {
    reasons.push("confidence below minimum approval threshold");
  }
  if (r.risk !== "low" && r.risk !== "medium" && r.risk !== "high") {
    reasons.push("invalid risk");
  }
  if (!r.expiresAt || new Date(r.expiresAt).getTime() <= reference.getTime()) {
    reasons.push("expires in the past");
  }
  // The blast radius comes from the expected impact; a "broad"
  // blast radius is not email-approvable and must be rejected at creation.
  const blastRadius = r.expectedImpact?.blastRadius;
  if (blastRadius !== "bounded") {
    reasons.push("not email-approvable: blast radius is not bounded");
  }
  const { approvable } = classifyRisk(r.risk, blastRadius);
  if (!approvable) reasons.push("not approvable by email (risk/scope policy)");
  // The stored payloadHash must equal a fresh canonical hash of the mutation.
  const expected = payloadHashOf({
    zoneId: r.zoneId,
    phase: r.phase,
    rulesetId: r.rulesetId,
    action: r.action,
    expression: r.expression,
    description: r.description,
    stableRuleRef: r.stableRuleRef,
    actionParameters: {},
  });
  if (r.payloadHash !== expected) reasons.push("payloadHash mismatch");
  if (r.mutationId !== mutationIdOf({
    zoneId: r.zoneId,
    phase: r.phase,
    rulesetId: r.rulesetId,
    action: r.action,
    expression: r.expression,
    description: r.description,
    stableRuleRef: r.stableRuleRef,
    actionParameters: {},
  })) reasons.push("mutationId mismatch");
  return { valid: reasons.length === 0, reasons };
}

/** Inputs to create an immutable {@link Recommendation}. */
export interface CreateRecommendationInput {
  findingId: string;
  zoneId: string;
  createdAt: string;
  expiresAt: string;
  type: string;
  expression: string;
  description: string;
  evidence: Evidence[];
  confidence: number;
  risk: RiskLevel;
  expectedImpact: ExpectedImpact;
  rulesetId: string;
  rulesetVersion: string;
  stableRuleRef: string;
  id: string;
  /**
   * The ruleset phase (D1-authoritative when a zone context is present).
   * Defaults to {@link RECOMMENDATION_PHASE} in single-zone mode.
   */
  phase?: string;
  /** Inject the reference clock so expiry validation is deterministic. */
  now?: Date;
}

/**
 * Create a fully-formed immutable recommendation. `mutationId` and
 * `payloadHash` are derived deterministically from the mutation fields; the
 * caller-provided `id` is the approval-facing revision.
 */
export function createRecommendation(input: CreateRecommendationInput): Recommendation {
  const phase = input.phase ?? RECOMMENDATION_PHASE;
  const mutation: ManagedChallengeMutation = {
    zoneId: input.zoneId,
    phase,
    rulesetId: input.rulesetId,
    action: "managed_challenge",
    expression: input.expression,
    description: input.description,
    stableRuleRef: input.stableRuleRef,
    actionParameters: {},
  };
  const validation = validateRecommendation(
    {
      id: input.id,
      zoneId: input.zoneId,
      phase,
      action: "managed_challenge",
      expression: input.expression,
      description: input.description,
      confidence: input.confidence,
      risk: input.risk,
      expectedImpact: input.expectedImpact,
      rulesetId: input.rulesetId,
      stableRuleRef: input.stableRuleRef,
      mutationId: mutationIdOf(mutation),
      payloadHash: payloadHashOf(mutation),
      expiresAt: input.expiresAt,
    },
    input.now,
    phase,
  );
  if (!validation.valid) {
    throw new Error(`invalid recommendation: ${validation.reasons.join("; ")}`);
  }

  return {
    id: input.id,
    findingId: input.findingId,
    zoneId: input.zoneId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    status: "pending_approval",
    type: input.type,
    action: "managed_challenge",
    phase,
    expression: input.expression,
    description: input.description,
    evidence: input.evidence,
    confidence: input.confidence,
    risk: input.risk,
    expectedImpact: input.expectedImpact,
    rulesetId: input.rulesetId,
    rulesetVersion: input.rulesetVersion,
    mutationId: mutationIdOf(mutation),
    payloadHash: payloadHashOf(mutation),
    stableRuleRef: input.stableRuleRef,
  };
}
