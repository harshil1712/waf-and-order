import { describe, expect, it, vi } from "vitest";

import { createIssueRecommendationTool, type ZoneStateSetter } from "../src/tools/issue-recommendation.ts";
import { createSendReportTool } from "../src/tools/send-report.ts";
import { TOKEN_VERSION } from "../src/shared/approval-token.ts";
import type { ZoneAgentState } from "../src/shared/types.ts";

const ZONE = "zone-abc";
const HOSTNAME = "example.com";
const SECRET = "test-secret";
const RULESET_ID = "ruleset-1";
const RULESET_VERSION = "42";

function fakeContext(data: unknown) {
  return {
    toolCallId: "call-1",
    signal: undefined,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    data,
  } as never;
}

function emptyState(): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId: ZONE,
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
  };
}

const INPUT = {
  findingId: "F-1",
  type: "datacenter_scraping",
  expression: "(ip.src.asnum in {16509 14618}) and not cf.client.bot",
  description: "AWS-hosted clients scrape profile pages.",
  evidence: [{ label: "7.8x increase", value: "metric" }],
  confidence: 0.91,
  risk: "medium",
  expectedImpact: { requestRatePerDay: 84210, likelyLegitimateExposure: "~0.3% heuristic", blastRadius: "bounded" },
  id: "R-1042",
};

/** Build the tool with trusted target injected from config (never the model). */
function makeTool(opts: { secret?: string; now?: Date; setState?: ZoneStateSetter } = {}) {
  return createIssueRecommendationTool({
    zoneId: ZONE,
    secret: opts.secret ?? SECRET,
    rulesetId: RULESET_ID,
    rulesetVersion: RULESET_VERSION,
    setState: opts.setState ?? (() => {}),
    now: opts.now,
  });
}

describe("createIssueRecommendationTool", () => {
  it("records an immutable recommendation and a token in state, returns metadata only", async () => {
    const now = new Date("2026-08-13T00:00:00Z");
    let state = emptyState();
    const setState: ZoneStateSetter = (updater) => {
      state = typeof updater === "function" ? updater(state) : updater;
    };
    const tool = makeTool({ secret: SECRET, now, setState });

    const result = (await tool.run(fakeContext(INPUT))) as { output: Record<string, unknown> };

    expect(result.output.recommendationId).toBe("R-1042");
    expect(result.output.approvalTokenId).toMatch(/^[0-9a-f]{32}$/);
    expect(result.output.approvalTokenVersion).toBe(TOKEN_VERSION);
    expect(result.output.mutationId).toMatch(/^m-/);
    expect(result.output.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // The signed bearer token must NOT be returned to the model: no field holds
    // a dotted `payload.sig` token, and no signedToken key is exposed.
    expect(result.output).not.toHaveProperty("signedToken");
    expect(String(result.output.approvalTokenId)).toMatch(/^[0-9a-f]{32}$/);

    expect(state.recommendations).toHaveLength(1);
    expect(state.recommendations[0].status).toBe("pending_approval");
    expect(state.approvalTokens).toHaveLength(1);
    expect(state.approvalTokens[0].recommendationId).toBe("R-1042");
    expect(state.approvalTokens[0].signedToken).toMatch(/\./);
    // Trusted target injected from config; stable ref derived from the id.
    expect(state.recommendations[0].rulesetId).toBe(RULESET_ID);
    expect(state.recommendations[0].rulesetVersion).toBe(RULESET_VERSION);
    expect(state.recommendations[0].stableRuleRef).toBe("botguard-R-1042");
  });

  it("fails closed (throws) when the signing secret is absent", async () => {
    const tool = makeTool({ secret: "", now: new Date("2026-08-13T00:00:00Z") });
    await expect(tool.run(fakeContext(INPUT))).rejects.toThrow(/not configured/);
  });

  it("rejects an invalid (e.g. expired) recommendation", async () => {
    const tool = makeTool({ now: new Date("2026-08-13T00:00:00Z") });
    await expect(
      tool.run(fakeContext({ ...INPUT, risk: "high", expectedImpact: { ...INPUT.expectedImpact, blastRadius: "broad" } })),
    ).rejects.toThrow(/invalid recommendation/);
  });

  it("generates collision-resistant ids that still match R-<digits> using the injected clock", async () => {
    const now = new Date("2026-08-13T00:00:00Z");
    let state = emptyState();
    const setState: ZoneStateSetter = (u) => { state = typeof u === "function" ? u(state) : u; };
    const tool = makeTool({ now, setState });

    const first = (await tool.run(fakeContext({ ...INPUT, id: undefined }))) as { output: { recommendationId: string } };
    const second = (await tool.run(fakeContext({ ...INPUT, id: undefined }))) as { output: { recommendationId: string } };

    expect(first.output.recommendationId).toMatch(/^R-\d+$/);
    // Two issuances at the same injected clock never collide.
    expect(first.output.recommendationId).not.toBe(second.output.recommendationId);
  });

  it("rejects a duplicate recommendation id in the functional state update", async () => {
    const now = new Date("2026-08-13T00:00:00Z");
    let state = emptyState();
    const setState: ZoneStateSetter = (u) => { state = typeof u === "function" ? u(state) : u; };
    const tool = makeTool({ now, setState });

    await tool.run(fakeContext({ ...INPUT, id: "R-1042" }));
    expect(state.recommendations).toHaveLength(1);
    await tool.run(fakeContext({ ...INPUT, id: "R-1042" })); // duplicate id
    expect(state.recommendations).toHaveLength(1); // not appended
  });
});

describe("createSendReportTool reply-to resolution", () => {
  it("resolves a signed Reply-To from state (never from the model) and passes it to the sender", async () => {
    const send = vi.fn(async (req: { replyTo?: string; reportId: string }) => ({
      sent: true, transport: "fake", detail: "", reportId: req.reportId,
    }));
    const resolveReplyTo = (id: string) =>
      id === "R-1042" ? "approve+token@security.example.com" : undefined;

    const tool = createSendReportTool({
      zoneId: ZONE,
      hostname: HOSTNAME,
      sender: { send },
      resolveReplyTo,
    });
    await tool.run(
      fakeContext({ reportId: "report-1", html: "", text: "", recommendationIds: ["R-1042"] }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].replyTo).toBe("approve+token@security.example.com");
  });

  it("omits Reply-To when no recommendation is listed", async () => {
    const send = vi.fn(async (req: { replyTo?: string }) => ({
      sent: true, transport: "fake", detail: "", reportId: "r",
    }));
    const tool = createSendReportTool({
      zoneId: ZONE,
      hostname: HOSTNAME,
      sender: { send },
      resolveReplyTo: () => "approve+x@y.example",
    });
    await tool.run(fakeContext({ reportId: "report-1", html: "", text: "" }));
    expect(send.mock.calls[0][0].replyTo).toBeUndefined();
  });

  it("surfaces a fail-closed send error instead of reporting a no-op success", async () => {
    const failingSender = {
      send: async () => {
        throw new Error("Email Sending binding is not configured; refusing to send.");
      },
    };
    const tool = createSendReportTool({
      zoneId: ZONE,
      hostname: HOSTNAME,
      sender: failingSender,
    });
    await expect(
      tool.run(fakeContext({ reportId: "report-1", html: "", text: "" })),
    ).rejects.toThrow(/not configured/);
  });
});