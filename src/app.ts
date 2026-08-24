import { createAgentRouter } from "@flue/runtime/routing";
import { dispatch } from "@flue/runtime";
import { Hono } from "hono";

import { ZoneBotAnalyst } from "./agents/zone-bot-analyst.ts";
import { accessMiddleware, type AccessConfig } from "./access/jwks.ts";
import { createOperatorApi } from "./operator/rollback-api.ts";
import { ZoneRegistryRepository } from "./registry/d1.ts";
import { CONTROL_PLANE_CONVERSATION_ID } from "./shared/control-plane.ts";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/health", (context) =>
  context.json({ service: "waf-and-order", status: "ok" }),
);

/** Access config resolved from env (fails closed when unset). */
function accessConfig(env: CloudflareBindings): AccessConfig {
  return {
    teamDomain: env.TEAM_DOMAIN,
    policyAud: env.POLICY_AUD,
  };
}

/** Allowed operator origins for browser POSTs (comma-separated env var). */
function allowedOrigins(env: CloudflareBindings): string[] {
  const raw = String(env.OPERATOR_ALLOWED_ORIGINS ?? "");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Hono middleware that enforces Access with env-resolved config. */
function requireAccess(): (c: import("hono").Context, next: import("hono").Next) => Promise<Response | void> {
  return (c, next) => accessMiddleware(accessConfig(c.env))(c, next);
}

/**
 * Agent mount, protected by Cloudflare Access only. The shared control-plane
 * agent lives at the single `control-plane` conversation id. Access remains the
 * sole protection for agent/operator routes and fails closed without
 * TEAM_DOMAIN/POLICY_AUD.
 */
app.use("/agents/zone-bot-analyst/*", requireAccess());
app.use("/agents/zone-bot-analyst/*", async (context, next) => {
  // Only the shared control-plane conversation is exposed here.
  const conversationId = context.req.path
    .slice("/agents/zone-bot-analyst/".length)
    .split("/", 1)[0];
  if (conversationId !== CONTROL_PLANE_CONVERSATION_ID) {
    return context.json({ error: "conversation_not_found" }, 404);
  }

  await next();
});

app.route("/agents/zone-bot-analyst", createAgentRouter(ZoneBotAnalyst));

/**
 * Operator API (Access-protected): list enabled zones and submit explicit
 * rollback confirmations. Writes a D1 audit row and dispatches the internal
 * `waf.rollback.authorized` signal to the shared control-plane agent.
 */
app.use("/operator/*", requireAccess());

app.route(
  "/operator",
  createOperatorApi({
    registryFor: (env) => new ZoneRegistryRepository(env.DB),
    allowedOriginsFor: (env) => allowedOrigins(env),
    dispatchRollback: async (attributes) => {
      await dispatch(ZoneBotAnalyst, {
        id: CONTROL_PLANE_CONVERSATION_ID,
        idempotencyKey: `rollback:${attributes.zoneId}:${attributes.recommendationId}`,
        message: {
          kind: "signal",
          type: "waf.rollback.authorized",
          body: "An authorized operator confirmed rollback.",
          attributes: {
            zoneId: attributes.zoneId,
            recommendationId: attributes.recommendationId,
            operatorIdentity: attributes.operatorIdentity ?? "",
          },
        },
      });
    },
  }),
);

export default app;
