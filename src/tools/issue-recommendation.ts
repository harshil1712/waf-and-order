/**
 * Agent tool: create an immutable recommendation and issue a signed approval
 * token.
 *
 * The tool is deterministic: it validates the inputs, derives the canonical
 * payload hash, mints a recommendation and a single-use token, and records both
 * in zone persistent state via a functional `usePersistentState` update. It
 * returns only metadata (ids, hash, expiry, risk) to the model — the signed
 * bearer token string is never returned into model context.
 * No WAF write occurs; approval is consumed later by the inbound signal path.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import {
  createRecommendation,
  DEFAULT_RECOMMENDATION_TTL_MS,
  RECOMMENDATION_PHASE,
  type RiskLevel,
} from "../shared/recommendation.ts";
import { signToken, TOKEN_VERSION } from "../shared/approval-token.ts";
import { stableRuleRefFor } from "../shared/apply-policy.ts";
import type { ZoneAgentState } from "../shared/types.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

/** A functional state setter compatible with usePersistentState. */
export type ZoneStateSetter = (
  value: ZoneAgentState | ((previous: ZoneAgentState) => ZoneAgentState),
) => void;

export interface IssueRecommendationDeps {
  zoneId: string;
  /** The Worker secret used to sign the approval token. */
  secret: string;
  /**
   * Trusted target from config (non-secret vars), injected — the model can
   * never choose the ruleset id or version. `rulesetVersion` is
   * recorded as context only.
   */
  rulesetId: string;
  rulesetVersion: string;
  setState: ZoneStateSetter;
  /** Inject a clock for deterministic tests. */
  now?: Date;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<
    ZoneContext,
    "resolveZoneConfig" | "resolveSlice" | "setSlice"
  >;
}

const evidenceSchema = v.object({
  label: v.string(),
  value: v.string(),
});

const expectedImpactSchema = v.object({
  requestRatePerDay: v.number(),
  likelyLegitimateExposure: v.string(),
  blastRadius: v.picklist(["bounded", "broad"]),
});

const inputSchema = v.object({
  findingId: v.string(),
  type: v.string(),
  expression: v.string(),
  description: v.string(),
  evidence: v.array(evidenceSchema),
  confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  risk: v.picklist(["low", "medium", "high"]),
  expectedImpact: expectedImpactSchema,
  id: v.optional(v.string()),
  /** The zone this recommendation targets (validated against D1). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  recommendationId: v.string(),
  mutationId: v.string(),
  payloadHash: v.string(),
  approvalTokenId: v.string(),
  approvalTokenVersion: v.number(),
  expiresAt: v.string(),
  risk: v.string(),
});

/** A short stable token nonce. */
function randomTokenId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** A small random numeric suffix (collision resistance for recommendation ids). */
function randomDigits(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += String(b % 10);
  return out;
}

/** Factory for the issue-recommendation tool. */
export function createIssueRecommendationTool({
  zoneId,
  secret,
  rulesetId,
  rulesetVersion,
  setState,
  now,
  zoneContext,
}: IssueRecommendationDeps) {
  return defineTool({
    name: "issue_recommendation",
    description:
      "Create an immutable Managed Challenge recommendation for a zone and issue a signed, expiring, single-use approval token. Records both in persistent state. Returns the recommendation id and approval token id (never the token itself). Optionally pass zoneId; the ruleset id/version and hostname are always resolved from trusted config, never supplied by you. No WAF change is made.",
    input: inputSchema,
    output: outputSchema,
    run: async ({ data }) => {
      if (!secret) {
        throw new Error("approval signing is not configured; cannot issue a token");
      }
      // Resolve the target zone (model-supplied zoneId validated against
      // D1, else the mounted default). The ruleset id/version always come from
      // D1 config, never from the model.
      let targetZoneId = zoneId;
      let targetRulesetId = rulesetId;
      let targetRulesetVersion = rulesetVersion;
      let targetPhase = RECOMMENDATION_PHASE;
      let targetStateSetter: ZoneStateSetter = setState;
      if (zoneContext) {
        const target = await resolveTargetZone(zoneContext, data.zoneId, zoneId);
        targetZoneId = target.zoneId;
        targetRulesetId = target.config?.rulesetId ?? rulesetId;
        targetRulesetVersion = target.config?.rulesetVersion ?? rulesetVersion;
        // The D1 ruleset_phase is authoritative; the model never supplies it.
        targetPhase = target.config?.rulesetPhase ?? RECOMMENDATION_PHASE;
        targetStateSetter = (value) =>
          zoneContext.setSlice(targetZoneId, value);
      }

      const clock = now ?? new Date();
      const createdAt = clock.toISOString();
      const expiresAt = new Date(clock.getTime() + DEFAULT_RECOMMENDATION_TTL_MS).toISOString();
      // Collision-resistant id that still matches R-<digits>: epoch-ms prefix
      // from the injected clock + a random numeric suffix. Never derived from
      // a bare Date.now() second timestamp (which could collide or ignore the
      // injected clock).
      const recommendationId =
        data.id ?? `R-${clock.getTime()}${randomDigits(6)}`;

      const recommendation = createRecommendation({
        id: recommendationId,
        findingId: data.findingId,
        zoneId: targetZoneId,
        createdAt,
        expiresAt,
        type: data.type,
        expression: data.expression,
        description: data.description,
        evidence: data.evidence,
        confidence: data.confidence,
        risk: data.risk as RiskLevel,
        expectedImpact: data.expectedImpact,
        // Injected from trusted config; the model can never choose these.
        rulesetId: targetRulesetId,
        rulesetVersion: targetRulesetVersion,
        // D1 ruleset_phase is authoritative.
        phase: targetPhase,
        // Deterministically derived from the recommendation id.
        stableRuleRef: stableRuleRefFor(recommendationId),
        now: clock,
      });

      const tokenId = randomTokenId();
      const tokenPayload = {
        version: TOKEN_VERSION,
        tokenId,
        zoneId: targetZoneId,
        recommendationId: recommendation.id,
        decision: "APPLY" as const,
        expiresAt,
      };
      const token = await signToken(tokenPayload, secret);
      const tokenRecord = {
        tokenId,
        recommendationId: recommendation.id,
        zoneId: targetZoneId,
        decision: "APPLY" as const,
        createdAt,
        expiresAt,
        payload: JSON.stringify(tokenPayload),
        signedToken: token,
      };

      targetStateSetter((prev) => {
        // Reject duplicates: never append a recommendation or token whose id
        // already exists in state. The functional update is the single source
        // of truth for idempotency under concurrent/retried runs.
        const hasDuplicateRecommendation = prev.recommendations.some(
          (r) => r.id === recommendation.id,
        );
        const hasDuplicateToken = prev.approvalTokens.some(
          (t) => t.tokenId === tokenId,
        );
        if (hasDuplicateRecommendation || hasDuplicateToken) {
          return prev;
        }
        return {
          ...prev,
          recommendations: [...prev.recommendations, recommendation],
          approvalTokens: [...prev.approvalTokens, tokenRecord],
        };
      });

      return {
        output: {
          recommendationId: recommendation.id,
          mutationId: recommendation.mutationId,
          payloadHash: recommendation.payloadHash,
          approvalTokenId: tokenId,
          approvalTokenVersion: TOKEN_VERSION,
          expiresAt,
          risk: recommendation.risk,
        },
      };
    },
  });
}