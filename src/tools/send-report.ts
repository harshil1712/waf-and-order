/**
 * Agent tool: send the weekly report.
 *
 * Delivers a rendered report through a {@link ReportSender}. Email Sending is
 * not onboarded for the zone, so the production sender fails closed: an
 * unconfigured send throws rather than reporting success. Tests inject a fake
 * sender. The tool accepts the rendered HTML/text produced by
 * generate_weekly_report.
 *
 * When a recommendation has an unconsumed approval token, the send tool
 * resolves the signed `Reply-To` address from persistent state (via
 * `resolveReplyTo`) rather than reading the token from the model, so the
 * bearer token never enters model context.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { reportSubject, type ReportSender } from "../shared/send.ts";
import { tokenForRecommendation } from "../shared/approval-state.ts";
import type { ZoneContext } from "./zone-context.ts";
import { resolveTargetZone } from "./zone-context.ts";

export interface SendReportToolDeps {
  zoneId: string;
  hostname: string;
  sender: ReportSender;
  /**
   * Resolve the signed Reply-To address for a recommendation id from
   * persistent state, or undefined when none exists. Injected by the agent.
   */
  resolveReplyTo?: (recommendationId: string) => string | undefined;
  /** Cross-zone resolution (optional; absent keeps single-zone mode). */
  zoneContext?: Pick<ZoneContext, "resolveZoneConfig" | "resolveSlice">;
}

const inputSchema = v.object({
  reportId: v.string(),
  html: v.string(),
  text: v.string(),
  endDay: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/))),
  recommendationIds: v.optional(v.array(v.string())),
  /** The zone the report belongs to (validated against D1). */
  zoneId: v.optional(v.string()),
});

const outputSchema = v.object({
  sent: v.boolean(),
  transport: v.string(),
  detail: v.string(),
  reportId: v.string(),
});

/** Factory for the send-report tool. */
export function createSendReportTool({ zoneId, hostname, sender, resolveReplyTo, zoneContext }: SendReportToolDeps) {
  return defineTool({
    name: "send_weekly_report",
    description:
      "Deliver the weekly report. Requires the reportId plus the rendered html and text from generate_weekly_report. Optionally pass recommendationIds to include signed approval Reply-To addresses. Optionally pass zoneId; the hostname is always resolved from trusted config, never supplied by you. Delivery fails closed if the email transport is not configured.",
    input: inputSchema,
    output: outputSchema,
    run: async ({ data }) => {
      const target = zoneContext
        ? await resolveTargetZone(zoneContext, data.zoneId, zoneId)
        : { zoneId };
      const targetZoneId = target.zoneId;
      const targetHostname = target.config?.hostname ?? hostname;
      const endDay = data.endDay;
      const subject = reportSubject(targetHostname, endDay ?? "");
      const recommendationIds = data.recommendationIds ?? [];
      // Resolve the first unconsumed token's reply address. Only one
      // recommendation per report is supported in the MVP.
      let replyTo: string | undefined;
      if (zoneContext && recommendationIds.length > 0) {
        // Resolve the signed Reply-To from the target zone's slice and
        // the D1-resolved hostname (never model-supplied).
        const slice = zoneContext.resolveSlice(targetZoneId);
        const domain = target.config?.hostname ?? targetHostname;
        const token = tokenForRecommendation(slice, recommendationIds[0]);
        if (token?.signedToken && domain) {
          replyTo = `approve+${token.signedToken}@${domain}`;
        }
      } else if (resolveReplyTo && recommendationIds.length > 0) {
        replyTo = resolveReplyTo(recommendationIds[0]);
      }
      const result = await sender.send({
        zoneId: targetZoneId,
        reportId: data.reportId,
        subject,
        html: data.html,
        text: data.text,
        replyTo,
      });
      return { output: result };
    },
  });
}