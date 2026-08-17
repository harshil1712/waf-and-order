import { describe, expect, it } from "vitest";

import { createMonitorRecommendationTool } from "../src/tools/monitor-recommendation.ts";
import type { ZoneStateSetter } from "../src/tools/issue-recommendation.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import type { ReportSender } from "../src/shared/send.ts";
import type { ZoneAgentState } from "../src/shared/types.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { fakeStep, durableContext } from "./helpers/fake-rulesets.ts";
import { HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

const REC_ID = "R-1042";
const NOW = new Date("2026-08-18T06:00:00Z");

function rollup(day: string, requestCount: number): DailyRollup {
  const content: Omit<DailyRollup, "sha256"> = {
    schemaVersion: 1,
    zoneId: ZONE_ID,
    hostname: HOSTNAME,
    day,
    periodStart: `${day}T00:00:00Z`,
    periodEnd: `${day}T23:59:59Z`,
    collectedAt: `${day}T04:00:00Z`,
    collectorVersion: "phase1.2.0",
    groupingSets: {
      verified_bot_country: [
        { groupingSet: "verified_bot_country", dimensions: { verifiedBotCategory: false, clientCountryName: "US" }, requestCount, bytes: requestCount * 400 },
      ],
    },
    truncatedGroupingSets: [],
  };
  return { ...content, sha256: sha256(content) };
}

/** Seed every day from 08-04 through 08-18 (exclusive of applied day 08-11). */
async function seededBucket(): Promise<FakeR2> {
  const bucket = new FakeR2();
  const days: Record<string, number> = {};
  for (let d = 4; d <= 18; d++) {
    if (d === 11) continue; // applied day excluded
    days[`2026-08-${String(d).padStart(2, "0")}`] = 100 + d;
  }
  for (const [day, count] of Object.entries(days)) {
    const r = rollup(day, count);
    const { sha256: _h, ...content } = r;
    r.sha256 = sha256(content);
    await bucket.put(`rollups/${ZONE_ID}/${day}.json`, JSON.stringify(r), {
      customMetadata: { zoneId: ZONE_ID, day, sha256: r.sha256 },
    });
  }
  return bucket;
}

function baseState(): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId: ZONE_ID,
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
  };
}

function makeTool(opts: {
  bucket?: FakeR2;
  sender?: ReportSender;
  state?: ZoneAgentState;
  endDay?: string;
} = {}) {
  const bucket = opts.bucket ?? new FakeR2();
  let current = opts.state ?? baseState();
  const setState: ZoneStateSetter = (updater) => {
    current = typeof updater === "function" ? updater(current) : updater;
  };
  const tool = createMonitorRecommendationTool({
    zoneId: ZONE_ID,
    hostname: HOSTNAME,
    resolveBucket: () => bucket,
    resolveAppliedRules: () =>
      current.appliedRules.map((a) => ({
        recommendationId: a.recommendationId,
        appliedAt: a.appliedAt,
        cloudflareRuleId: a.cloudflareRuleId,
      })),
    resolveMonitoringRecords: () => current.monitoringRecords ?? [],
    resolveEndDay: () => opts.endDay ?? "2026-08-18",
    setState,
    sender: opts.sender,
    now: NOW,
  });
  return { tool, bucket, getState: () => current };
}

const fakeSender: ReportSender = {
  send: async (req) => ({ sent: true, transport: "fake", detail: "mocked", reportId: req.reportId }),
};

function appliedState(): ZoneAgentState {
  const s = baseState();
  s.appliedRules = [
    { recommendationId: REC_ID, cloudflareRuleId: "cf-rule-1", mutationId: "m-x", payloadHash: "h", appliedAt: "2026-08-11T00:00:00Z", status: "applied" },
  ];
  return s;
}

type Output = {
  endDay: string;
  processed: {
    recommendationId: string;
    checkpoint: string;
    reportId: string;
    outcomeKey: string;
    preRequests: number;
    postRequests: number;
    fullCoverage: boolean;
    sent: boolean;
    transport: string;
    detail: string;
  }[];
  skippedNotDue: string[];
};

describe("createMonitorRecommendationTool (all-due, no model input, §16)", () => {
  it("processes 24h then 7d exactly once each for a due applied rule, deterministically", async () => {
    const bucket = await seededBucket();
    const { tool, getState } = makeTool({ bucket, sender: fakeSender, state: appliedState(), endDay: "2026-08-18" });
    const step = fakeStep();
    const result = (await tool.run(durableContext({}, step))) as { output: Output };

    expect(result.output.endDay).toBe("2026-08-18");
    // Order: 24h before 7d.
    expect(result.output.processed.map((p) => p.checkpoint)).toEqual(["24h", "7d"]);
    const byCp = Object.fromEntries(result.output.processed.map((p) => [p.checkpoint, p]));
    // 24h: pre=[08-10]=110, post=[08-12]=112
    expect(byCp["24h"].preRequests).toBe(110);
    expect(byCp["24h"].postRequests).toBe(112);
    // 7d: pre=sum(08-04..08-10)=104..110, post=sum(08-12..08-18)=112..118
    const preSum = Array.from({ length: 7 }, (_, i) => 104 + i).reduce((a, b) => a + b, 0);
    const postSum = Array.from({ length: 7 }, (_, i) => 112 + i).reduce((a, b) => a + b, 0);
    expect(byCp["7d"].preRequests).toBe(preSum);
    expect(byCp["7d"].postRequests).toBe(postSum);
    expect(byCp["7d"].fullCoverage).toBe(true);

    // Outcomes persisted to R2 (distinct keys).
    expect(bucket.objects.has(`outcomes/${ZONE_ID}/R-1042/24h.json`)).toBe(true);
    expect(bucket.objects.has(`outcomes/${ZONE_ID}/R-1042/7d.json`)).toBe(true);
    // Concise records in state, one per checkpoint.
    expect(getState().monitoringRecords!.map((r) => r.checkpoint).sort()).toEqual(["24h", "7d"]);
    // Both sent.
    expect(byCp["24h"].sent).toBe(true);
    expect(byCp["7d"].sent).toBe(true);
  });

  it("is idempotent: a re-run with recorded checkpoints processes nothing new", async () => {
    const bucket = await seededBucket();
    const { tool, getState, bucket: b } = makeTool({ bucket, sender: fakeSender, state: appliedState(), endDay: "2026-08-18" });

    const first = (await tool.run(durableContext({}, fakeStep()))) as { output: Output };
    expect(first.output.processed).toHaveLength(2);
    const outcomeCount = [...b.objects.keys()].filter((k) => k.startsWith("outcomes/")).length;
    const recordCount = getState().monitoringRecords!.length;

    // Re-run: resolveMonitoringRecords now reflects recorded checkpoints → none due.
    const second = (await tool.run(durableContext({}, fakeStep()))) as { output: Output };
    expect(second.output.processed).toHaveLength(0);
    expect([...b.objects.keys()].filter((k) => k.startsWith("outcomes/"))).toHaveLength(outcomeCount);
    expect(getState().monitoringRecords!.length).toBe(recordCount);
  });

  it("processes only due checkpoints: 7d is skipped when endDay is too early", async () => {
    const bucket = await seededBucket();
    const { tool, getState } = makeTool({ bucket, sender: fakeSender, state: appliedState(), endDay: "2026-08-12" });
    const step = fakeStep();
    const result = (await tool.run(durableContext({}, step))) as { output: Output };
    // 7d requires endDay >= 08-18; only 24h (endDay >= 08-12) is due.
    expect(result.output.processed.map((p) => p.checkpoint)).toEqual(["24h"]);
    expect(result.output.processed[0].postRequests).toBe(112);
    expect(getState().monitoringRecords!.map((r) => r.checkpoint)).toEqual(["24h"]);
    expect(bucket.objects.has(`outcomes/${ZONE_ID}/R-1042/7d.json`)).toBe(false);
  });

  it("processes multiple applied recommendations with due checkpoints", async () => {
    const bucket = await seededBucket();
    const state = appliedState();
    state.appliedRules.push({
      recommendationId: "R-2000",
      cloudflareRuleId: "cf-rule-2",
      mutationId: "m-y",
      payloadHash: "h",
      appliedAt: "2026-08-11T00:00:00Z",
      status: "applied",
    });
    const { tool, getState } = makeTool({ bucket, sender: fakeSender, state, endDay: "2026-08-18" });
    const step = fakeStep();
    const result = (await tool.run(durableContext({}, step))) as { output: Output };
    expect(result.output.processed.map((p) => `${p.recommendationId}:${p.checkpoint}`)).toEqual([
      "R-1042:24h", "R-1042:7d", "R-2000:24h", "R-2000:7d",
    ]);
    expect(getState().monitoringRecords!.length).toBe(4);
  });

  it("persists outcomes even when no sender is configured (sent:false)", async () => {
    const bucket = await seededBucket();
    const { tool, bucket: b } = makeTool({ bucket, state: appliedState(), endDay: "2026-08-12" });
    const step = fakeStep();
    const result = (await tool.run(durableContext({}, step))) as { output: Output };
    expect(result.output.processed[0].sent).toBe(false);
    expect(result.output.processed[0].transport).toBe("none");
    expect(b.objects.has(result.output.processed[0].outcomeKey)).toBe(true);
  });

  it("marks unavailable metrics explicitly in the report it would send", async () => {
    const bucket = await seededBucket();
    let captured: { html: string; text: string } | undefined;
    const sender: ReportSender = {
      send: async (req) => {
        captured = { html: req.html, text: req.text };
        return { sent: true, transport: "fake", detail: "mocked", reportId: req.reportId };
      },
    };
    const { tool } = makeTool({ bucket, sender, state: appliedState(), endDay: "2026-08-18" });
    const step = fakeStep();
    await tool.run(durableContext({}, step));
    expect(captured?.text).toContain("challenge_solve_rate: unavailable");
    expect(captured?.text).toContain("rule_match_count: unavailable");
    expect(captured?.html).toContain("origin_error_rate");
  });
});