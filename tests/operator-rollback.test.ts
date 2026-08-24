import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import {
  createOperatorApi,
  isAllowedOrigin,
  sameOrigin,
  ROLLBACK_REQUEST_ACTION,
} from "../src/operator/rollback-api.ts";
import {
  buildRollbackTarget,
  crossCheckRollbackTarget,
  runAuthorizedRollback,
  shouldMarkRolledBack,
} from "../src/operator/rollback-handler.ts";
import { ROLLBACK_CONFIRMATION_PHRASE } from "../src/registry/operator-actions.ts";
import { ZoneRegistryRepository } from "../src/registry/d1.ts";
import type { ZoneConfig } from "../src/registry/zone-registry.ts";
import { markRolledBack } from "../src/shared/monitor-state.ts";
import { FakeD1, zoneRowForTest } from "./helpers/fake-d1.ts";
import { FakeRulesets } from "./helpers/fake-rulesets.ts";
import type { ZoneAgentState } from "../src/shared/types.ts";

const NOW = new Date("2026-08-12T00:00:00Z");

function configFor(zoneId = "zone-a", phase = "http_request_firewall_custom"): ZoneConfig {
  return {
    zoneId,
    hostname: "a.example.com",
    rulesetId: "ruleset-a",
    rulesetPhase: phase,
    rulesetVersion: "1",
    enabled: true,
    allowedEnvelopeSenders: [],
    reportSender: "",
    reportRecipient: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** A zone slice with one recommendation in a given lifecycle status. */
function sliceWithStatus(status: ZoneAgentState["recommendations"][number]["status"]): ZoneAgentState {
  const base: ZoneAgentState = {
    schemaVersion: 2,
    zoneId: "zone-a",
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    monitoringRecords: [],
    rollbackOutcomes: [],
  };
  const rec: ZoneAgentState["recommendations"][number] = {
    id: "R-1",
    zoneId: "zone-a",
    status,
    expiresAt: "2026-09-01T00:00:00Z",
    rulesetId: "ruleset-a",
    phase: "http_request_firewall_custom",
    action: "managed_challenge",
    expression: "ip.src.asnum in {12345} and not cf.client.bot",
    description: "block scanners",
    stableRuleRef: "botguard-R-1",
    payloadHash: "h",
    mutationId: "m-1",
    findingId: "F-1",
    createdAt: "2026-08-01T00:00:00Z",
    type: "datacenter_scraping",
    evidence: [],
    confidence: 0.9,
    risk: "medium",
    expectedImpact: { requestRatePerDay: 1, likelyLegitimateExposure: "x", blastRadius: "bounded" },
    rulesetVersion: "1",
  };
  return {
    ...base,
    recommendations: [rec],
    appliedRules:
      status === "applied" || status === "monitoring" || status === "rollback_recommended"
        ? [{ recommendationId: "R-1", cloudflareRuleId: "cf-rule-1", mutationId: "m-1", payloadHash: "h", appliedAt: "2026-08-01T00:00:00Z", status: "applied" }]
        : [],
  };
}

/** A matching rule on the fake client so read-before-delete resolves cleanly. */
function seedMatchingRule(client: FakeRulesets) {
  client.rules = [
    {
      id: "cf-rule-1",
      ref: "botguard-R-1",
      expression: "ip.src.asnum in {12345} and not cf.client.bot",
      action: "managed_challenge",
      description: "block scanners",
      enabled: true,
    },
  ];
}

describe("markRolledBack lifecycle", () => {
  it("transitions applied → rolled_back (rec + appliedRules)", () => {
    const t = markRolledBack(sliceWithStatus("applied"), { recommendationId: "R-1", now: NOW });
    expect(t.applied).toBe(true);
    expect(t.next?.recommendations[0].status).toBe("rolled_back");
    expect(t.next?.appliedRules[0].status).toBe("rolled_back");
  });

  it("transitions monitoring → rolled_back", () => {
    const t = markRolledBack(sliceWithStatus("monitoring"), { recommendationId: "R-1", now: NOW });
    expect(t.applied).toBe(true);
    expect(t.next?.recommendations[0].status).toBe("rolled_back");
  });

  it("transitions rollback_recommended → rolled_back", () => {
    const t = markRolledBack(sliceWithStatus("rollback_recommended"), { recommendationId: "R-1", now: NOW });
    expect(t.applied).toBe(true);
    expect(t.next?.recommendations[0].status).toBe("rolled_back");
  });

  it("is idempotent when already rolled_back", () => {
    const already = sliceWithStatus("rolled_back");
    const t = markRolledBack(already, { recommendationId: "R-1", now: NOW });
    expect(t.applied).toBe(true);
    expect(t.reason).toBe("already_rolled_back");
    expect(t.next).toBe(already);
  });

  it("refuses a non-rollbackable status (expected-prior-state discipline)", () => {
    const t = markRolledBack(sliceWithStatus("pending_approval"), { recommendationId: "R-1", now: NOW });
    expect(t.applied).toBe(false);
    expect(t.reason).toMatch(/not_rollbackable/);
  });
});

describe("operator rollback API", () => {
  function buildApp(opts: {
    zones?: ReturnType<typeof zoneRowForTest>[];
    dispatch?: (a: unknown) => Promise<void>;
  } = {}) {
    const db = new FakeD1(opts.zones ?? [zoneRowForTest("zone-a", "a.example.com")]);
    const repo = new ZoneRegistryRepository(db);
    const dispatchRollback = opts.dispatch ?? vi.fn(async () => {});
    const app = new Hono();
    app.use("/operator/*", async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set("operator", {
        email: "operator@example.com",
      });
      await next();
    });
    app.route(
      "/operator",
      createOperatorApi({
        registryFor: () => repo,
        dispatchRollback,
        now: () => NOW,
      }),
    );
    return { app, db, repo, dispatchRollback };
  }

  const POST = (zoneId: string, recommendationId: string, confirmation: string) =>
    JSON.stringify({ zoneId, recommendationId, confirmation });

  it("lists enabled zones (read-only)", async () => {
    const { app } = buildApp();
    const res = await app.request("/operator/zones");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zones: { zoneId: string; hostname: string; enabled: boolean }[] };
    expect(body.zones).toEqual([{ zoneId: "zone-a", hostname: "a.example.com", enabled: true }]);
  });

  it("accepts an explicit rollback confirmation, audits as REQUESTED, and dispatches", async () => {
    const { app, db, dispatchRollback } = buildApp();
    const res = await app.request("/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST("zone-a", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { action: string };
    // The initial audit row is an authenticated REQUEST, not a successful execution.
    expect(body.action).toBe(ROLLBACK_REQUEST_ACTION);
    expect(dispatchRollback).toHaveBeenCalledTimes(1);
    expect(dispatchRollback).toHaveBeenCalledWith({
      zoneId: "zone-a",
      recommendationId: "R-1",
      operatorIdentity: "operator@example.com",
    });
    const { results } = await db
      .prepare(
        "SELECT action, operator_identity FROM operator_actions WHERE zone_id = ? ORDER BY id DESC LIMIT ?",
      )
      .bind("zone-a", 10)
      .all<{ action: string; operator_identity: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe(ROLLBACK_REQUEST_ACTION);
    expect(results[0].operator_identity).toBe("operator@example.com");
  });

  it("rejects a missing or wrong confirmation phrase", async () => {
    const { app, dispatchRollback } = buildApp();
    const res = await app.request("/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST("zone-a", "R-1", "yes"),
    });
    expect(res.status).toBe(400);
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it("rejects missing zoneId / recommendationId", async () => {
    const { app, dispatchRollback } = buildApp();
    const res = await app.request("/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST("", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(res.status).toBe(400);
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it("rejects an unknown or disabled zone", async () => {
    const { app, dispatchRollback } = buildApp();
    const res = await app.request("/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST("zone-nope", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(res.status).toBe(404);
    expect(dispatchRollback).not.toHaveBeenCalled();
  });

  it("accepts same-origin browser POSTs and rejects cross-origin POSTs", async () => {
    const { app, dispatchRollback } = buildApp();
    const good = await app.request("https://ops.example.com/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://ops.example.com" },
      body: POST("zone-a", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(good.status).toBe(202);

    const bad = await app.request("https://ops.example.com/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: POST("zone-a", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(bad.status).toBe(403);
    expect(dispatchRollback).toHaveBeenCalledTimes(1);
  });

  it("accepts POSTs with no Origin header (non-browser API client)", async () => {
    const { app, dispatchRollback } = buildApp();
    const res = await app.request("https://ops.example.com/operator/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: POST("zone-a", "R-1", ROLLBACK_CONFIRMATION_PHRASE),
    });
    expect(res.status).toBe(202);
    expect(dispatchRollback).toHaveBeenCalledTimes(1);
  });

  it("isAllowedOrigin permits a request with no Origin header", () => {
    expect(isAllowedOrigin(undefined, "https://x.example/operator/rollback")).toBe(true);
  });

  it("sameOrigin compares scheme+host+port", () => {
    expect(sameOrigin("https://ops.example.com", "https://ops.example.com/operator/rollback")).toBe(true);
    expect(sameOrigin("https://evil.example.com", "https://ops.example.com/operator/rollback")).toBe(false);
    expect(sameOrigin("http://ops.example.com", "https://ops.example.com/operator/rollback")).toBe(false);
    expect(sameOrigin("not-a-url", "https://ops.example.com/operator/rollback")).toBe(false);
  });
});

describe("rollback handler (deterministic, fail-closed)", () => {
  it("builds a rollback target from trusted state + D1 config", () => {
    const slice = sliceWithStatus("monitoring");
    const target = buildRollbackTarget(slice, configFor(), "R-1");
    expect(target?.rulesetId).toBe("ruleset-a");
    expect(target?.cloudflareRuleId).toBe("cf-rule-1");
    expect(target?.stableRuleRef).toBe("botguard-R-1");
  });

  it("cross-checks zone/ruleset/phase and fails closed on a cross-zone slice", () => {
    const slice = sliceWithStatus("monitoring");
    // Recommendation in zone-a but D1 config says zone-b (different ruleset too).
    const contaminated = crossCheckRollbackTarget(slice, "zone-b", configFor("zone-b", "other-phase"), "R-1");
    expect(contaminated.ok).toBe(false);
  });

  it("performs a guarded single-rule DELETE and returns deleted", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    seedMatchingRule(client);
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client, now: NOW });
    expect(result.outcome).toBe("deleted");
    if (result.outcome === "deleted") expect(result.resolvedRuleId).toBe("cf-rule-1");
    expect(client.deletes).toEqual([{ ruleId: "cf-rule-1" }]);
    expect(shouldMarkRolledBack(result)).toBe(true);
  });

  it("returns already_absent when the rule is already gone (crash/retry convergence)", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets(); // no rules seeded → absent confirmed
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client, now: NOW });
    expect(result.outcome).toBe("already_absent");
    expect(shouldMarkRolledBack(result)).toBe(true);
  });

  it("returns aborted on drifted/duplicate refs (never marks rolled_back)", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-rule-1", ref: "botguard-R-1", expression: "http.host eq \"drifted\"", action: "managed_challenge", enabled: true },
    ];
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client, now: NOW });
    expect(result.outcome).toBe("aborted");
    expect(shouldMarkRolledBack(result)).toBe(false);
    expect(client.deletes).toEqual([]);
  });

  it("fails closed (credential_absent) and never marks rolled_back", async () => {
    const slice = sliceWithStatus("monitoring");
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client: null, now: NOW });
    expect(result.outcome).toBe("not_performed");
    if (result.outcome === "not_performed") expect(result.reason).toBe("credential_absent");
    expect(shouldMarkRolledBack(result)).toBe(false);
  });

  it("fails closed for a disabled zone", async () => {
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: { ...configFor(), enabled: false }, slice: sliceWithStatus("monitoring"), client: new FakeRulesets(), now: NOW });
    expect(result.outcome).toBe("not_performed");
    if (result.outcome === "not_performed") expect(result.reason).toBe("unknown_or_disabled_zone");
    expect(shouldMarkRolledBack(result)).toBe(false);
  });

  it("fails closed for a non-rollbackable recommendation", async () => {
    const slice = sliceWithStatus("pending_approval");
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client: new FakeRulesets(), now: NOW });
    expect(result.outcome).toBe("not_performed");
    if (result.outcome === "not_performed") expect(result.reason).toMatch(/not_rollbackable/);
    expect(shouldMarkRolledBack(result)).toBe(false);
  });

  it("fails closed on a contaminated/cross-zone slice without deleting", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    seedMatchingRule(client);
    // The slice's recommendation is zone-a/ruleset-a, but the D1 config is zone-b.
    const result = await runAuthorizedRollback({ zoneId: "zone-b", recommendationId: "R-1", config: configFor("zone-b"), slice, client, now: NOW });
    expect(result.outcome).toBe("not_performed");
    if (result.outcome === "not_performed") expect(result.reason).toMatch(/contaminated_zone/);
    expect(client.deletes).toEqual([]);
  });

  it("fails closed when D1 ruleset_phase mismatches the recommendation", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    seedMatchingRule(client);
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor("zone-a", "some-other-phase"), slice, client, now: NOW });
    expect(result.outcome).toBe("not_performed");
    if (result.outcome === "not_performed") expect(result.reason).toMatch(/contaminated_zone/);
    expect(client.deletes).toEqual([]);
  });

  it("records a post-guard outcome audit", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    seedMatchingRule(client);
    const recordOutcome = vi.fn(async () => {});
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client, now: NOW, recordOutcome });
    expect(result.outcome).toBe("deleted");
    expect(recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "deleted", resolvedRuleId: "cf-rule-1" }),
    );
  });

  it("does not record a deleted outcome when it aborts", async () => {
    const slice = sliceWithStatus("monitoring");
    const client = new FakeRulesets();
    client.rules = [
      { id: "cf-rule-1", ref: "botguard-R-1", expression: "drifted", action: "managed_challenge", enabled: true },
    ];
    const recordOutcome = vi.fn(async () => {});
    const result = await runAuthorizedRollback({ zoneId: "zone-a", recommendationId: "R-1", config: configFor(), slice, client, now: NOW, recordOutcome });
    expect(result.outcome).toBe("aborted");
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "aborted" }));
  });
});
