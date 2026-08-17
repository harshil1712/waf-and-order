/**
 * Agent tool: apply an approved recommendation.
 *
 * The model supplies ONLY two identifiers — `recommendationId` and
 * `approvalTokenId`. Everything else (the exact mutation, the target
 * zone/ruleset/phase, the risk and expression policy, the stable reference) is
 * loaded from trusted persistent state and validated deterministically here.
 * The model cannot choose the zone, expression, action, ruleset, or API method.
 *
 * The tool is DURABLE (`durable: true`, Flue 2.0.3). Every external side
 * effect goes through `step.do(...)` checkpoints: authorization, read-before-
 * write reconciliation, and read-after-write verification. If the run is
 * interrupted, completed steps replay their recorded values and the state
 * transitions are idempotent (expected-prior-state reducers), so an at-least-
 * once execution never creates a duplicate rule.
 *
 * We only POST a single rule — never PUT a whole ruleset — so unrelated rules
 * are preserved. No live WAF write is performed by tests; the client is a fake.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import type { ZoneAgentState } from "../shared/types.ts";
import { RECOMMENDATION_PHASE } from "../shared/recommendation.ts";
import { authorizeApplication } from "../shared/apply-policy.ts";
import { beginApply, markApplied, markMonitoring } from "../shared/apply-state.ts";
import {
  reconcileOrCreate,
  verifyRuleReadAfterWrite,
  type ApplyRulePayload,
} from "../cloudflare/apply-io.ts";
import type { RulesetsClient } from "../cloudflare/rulesets.ts";
import type { ConfirmationSender } from "../email/sender.ts";
import type { ZoneStateSetter } from "./issue-recommendation.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

export interface ApplyRecommendationDeps {
  zoneId: string;
  /** Trusted target from config (non-secret vars), injected — never model-chosen. */
  config: { rulesetId: string; rulesetVersion: string };
  /** Application-owned Rulesets client bound to WAF_WRITE_TOKEN (never MCP). */
  client: RulesetsClient;
  /** Render-time snapshot of trusted persistent state. */
  state: ZoneAgentState;
  setState: ZoneStateSetter;
  /** Fail-closed confirmation sender (mocked in tests). */
  sender?: ConfirmationSender;
  /** Inject a clock for deterministic tests. */
  now?: Date;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<
    ZoneContext,
    "resolveZoneConfig" | "resolveSlice" | "setSlice"
  >;
}

const inputSchema = v.object({
  recommendationId: v.string(),
  approvalTokenId: v.string(),
  /** The zone whose slice owns this recommendation (validated). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  applied: v.boolean(),
  reason: v.string(),
  recommendationId: v.string(),
  cloudflareRuleId: v.optional(v.string()),
  mutationId: v.optional(v.string()),
});

/** Build the exact rule payload from an authorization. */
function toRulePayload(
  rule: NonNullable<ReturnType<typeof authorizeApplication>["rule"]>,
): ApplyRulePayload {
  return rule;
}

/** Factory for the durable apply tool. */
export function createApplyRecommendationTool(deps: ApplyRecommendationDeps) {
  return defineTool({
    name: "apply_approved_recommendation",
    description:
      "Apply an approved Managed Challenge recommendation. Takes only the recommendation id and the approval token id, plus an optional zoneId. The exact rule is loaded from trusted state and verified; a single rule is created in the zone custom ruleset via the application-owned Rulesets client. The zone, ruleset, expression, action, and payload are always resolved from trusted D1/state — never supplied by you. Never PUTs the whole ruleset. Fails closed on any authorization or policy violation.",
    input: inputSchema,
    output: outputSchema,
    durable: true,
    run: async ({ data, step }) => {
      // Resolve the target zone (model-supplied zoneId validated
      // against D1, else the mounted default) and its state slice. The zone and
      // ruleset always come from D1 config; the model supplies only identifiers.
      let targetZoneId = deps.zoneId;
      let targetRulesetId = deps.config.rulesetId;
      let targetPhase = RECOMMENDATION_PHASE;
      let slice: ZoneAgentState = deps.state;
      let setSlice: ZoneStateSetter = deps.setState;
      if (deps.zoneContext) {
        const target = await resolveTargetZone(
          deps.zoneContext,
          data.zoneId,
          deps.zoneId,
        );
        targetZoneId = target.zoneId;
        targetRulesetId = target.config?.rulesetId ?? deps.config.rulesetId;
        // The D1 ruleset_phase is authoritative; the model never supplies it.
        targetPhase = target.config?.rulesetPhase ?? RECOMMENDATION_PHASE;
        slice = deps.zoneContext.resolveSlice(targetZoneId);
        setSlice = (value) => deps.zoneContext!.setSlice(targetZoneId, value);
      }
      const target = { zoneId: targetZoneId, phase: targetPhase, rulesetId: targetRulesetId };

      const clock = deps.now ?? new Date();
      const intent = {
        recommendationId: data.recommendationId,
        approvalTokenId: data.approvalTokenId,
        now: clock,
      };

      // Step 1: authorization (pure, against trusted persistent state). This
      // cross-checks the stored recommendation's zone/ruleset/phase against the
      // D1-resolved target, so a recommendation from another zone is denied.
      const auth = await step.do("authorize", () =>
        authorizeApplication(slice, data.recommendationId, data.approvalTokenId, clock, target),
      );
      if (!auth.ok || !auth.rule) {
        return {
          output: {
            applied: false,
            reason: `authorization_denied:${(auth.reasons ?? []).join(";")}`,
            recommendationId: data.recommendationId,
          },
        };
      }
      const rule = toRulePayload(auth.rule);

      // Step 2: read-before-write reconcile-or-create (the idempotency boundary).
      const reconcile = await step.do("reconcile-or-create", () =>
        reconcileOrCreate(deps.client, target, rule),
      );

      // Step 3: read-after-write exact verification.
      const verified = await step.do("verify", () =>
        verifyRuleReadAfterWrite(deps.client, target, reconcile.cloudflareRuleId, rule),
      );
      if (!verified) {
        return {
          output: {
            applied: false,
            reason: "read_after_write_mismatch",
            recommendationId: data.recommendationId,
            cloudflareRuleId: reconcile.cloudflareRuleId,
          },
        };
      }

      // Persist the expected-prior-state transitions atomically (idempotent) in
      // the target zone's slice only.
      setSlice((prev) => {
        let s = beginApply(prev, intent);
        if (s.applied && s.next) {
          s = markApplied(s.next, intent, reconcile.cloudflareRuleId);
        }
        if (s.applied && s.next) {
          s = markMonitoring(s.next, intent);
        }
        return s.next ?? prev;
      });

      // Step 4: fail-closed confirmation email (mocked in tests).
      let emailDetail = "no sender configured";
      if (deps.sender) {
        const email = await step.do("confirmation-email", () =>
          deps.sender!.sendConfirmation({
            zoneId: targetZoneId,
            recommendationId: data.recommendationId,
            cloudflareRuleId: reconcile.cloudflareRuleId,
            mutationId: auth.mutationId ?? "",
            appliedAt: clock.toISOString(),
          }),
        );
        emailDetail = `${email.transport}: ${email.detail}`;
      }

      return {
        output: {
          applied: true,
          reason: `applied via single-rule POST (${emailDetail})`,
          recommendationId: data.recommendationId,
          cloudflareRuleId: reconcile.cloudflareRuleId,
          mutationId: auth.mutationId,
        },
      };
    },
  });
}
