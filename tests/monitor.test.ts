import { describe, expect, it } from "vitest";

import {
  buildMonitoringReport,
  buildMonitoringMetrics,
  checkpointDays,
  computeWindowTotals,
  dueCheckpoints,
  isCheckpointDue,
  outcomeId,
  postWindowDays,
  postWindowEnd,
  preWindowDays,
  renderMonitoringHtml,
  renderMonitoringText,
} from "../src/analytics/monitor.ts";
import { outcomeKey } from "../src/analytics/outcome-storage.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

/** Build a daily rollup for `day` with the given verified_bot_country total. */
function rollup(day: string, requestCount: number, bytes = requestCount * 400, truncated = false): DailyRollup {
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
        {
          groupingSet: "verified_bot_country",
          dimensions: { verifiedBotCategory: false, clientCountryName: "US" },
          requestCount,
          bytes,
        },
      ],
    },
    truncatedGroupingSets: truncated ? ["verified_bot_country"] : [],
  };
  return { ...content, sha256: sha256(content) };
}

async function seed(bucket: FakeR2, days: Record<string, number>, truncatedDays: string[] = []) {
  for (const [day, count] of Object.entries(days)) {
    const r = rollup(day, count, count * 400, truncatedDays.includes(day));
    const { sha256: _h, ...content } = r;
    r.sha256 = sha256(content);
    await bucket.put(`rollups/${ZONE_ID}/${day}.json`, JSON.stringify(r), {
      customMetadata: { zoneId: ZONE_ID, day, sha256: r.sha256 },
    });
  }
}

describe("window day ranges (non-overlapping full-day semantics)", () => {
  it("24h: pre is the single prior day, post is the single day after applied", () => {
    expect(preWindowDays("2026-08-11", 1)).toEqual(["2026-08-10"]);
    expect(postWindowDays("2026-08-11", 1)).toEqual(["2026-08-12"]);
  });

  it("7d: pre is the 7 full days ending before applied, post the 7 starting after", () => {
    expect(preWindowDays("2026-08-11", 7)).toEqual([
      "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10",
    ]);
    expect(postWindowDays("2026-08-11", 7)).toEqual([
      "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
    ]);
  });

  it("pre and post never overlap and never include the applied day", () => {
    for (const count of [1, 7]) {
      const pre = preWindowDays("2026-08-11", count);
      const post = postWindowDays("2026-08-11", count);
      expect(pre.some((d) => d === "2026-08-11")).toBe(false);
      expect(post.some((d) => d === "2026-08-11")).toBe(false);
      for (const d of pre) expect(post).not.toContain(d);
      for (const d of post) expect(pre).not.toContain(d);
    }
  });

  it("checkpointDays maps 24h→1 and 7d→7", () => {
    expect(checkpointDays("24h")).toBe(1);
    expect(checkpointDays("7d")).toBe(7);
  });

  it("postWindowEnd is appliedDay + count", () => {
    expect(postWindowEnd("2026-08-11", 1)).toBe("2026-08-12");
    expect(postWindowEnd("2026-08-11", 7)).toBe("2026-08-18");
  });
});

describe("isCheckpointDue / dueCheckpoints", () => {
  it("a checkpoint is due only once the full post window is available", () => {
    expect(isCheckpointDue("2026-08-11", 1, "2026-08-11")).toBe(false); // early
    expect(isCheckpointDue("2026-08-11", 1, "2026-08-12")).toBe(true); // due
    expect(isCheckpointDue("2026-08-11", 7, "2026-08-17")).toBe(false); // early
    expect(isCheckpointDue("2026-08-11", 7, "2026-08-18")).toBe(true); // due
  });

  it("dueCheckpoints returns 24h then 7d, skipping recorded and not-yet-due checkpoints", () => {
    const endDay = "2026-08-18";
    expect(dueCheckpoints("2026-08-11", endDay, [])).toEqual(["24h", "7d"]);
    // 7d recorded → only 24h due.
    expect(dueCheckpoints("2026-08-11", endDay, [{ checkpoint: "7d" }])).toEqual(["24h"]);
    // both recorded → none.
    expect(dueCheckpoints("2026-08-11", endDay, [{ checkpoint: "24h" }, { checkpoint: "7d" }])).toEqual([]);
    // 7d not yet due → only 24h.
    expect(dueCheckpoints("2026-08-11", "2026-08-12", [])).toEqual(["24h"]);
  });
});

describe("computeWindowTotals", () => {
  it("sums request count and bytes across the given days and reports missing days", async () => {
    const bucket = new FakeR2();
    await seed(bucket, { "2026-08-08": 100, "2026-08-09": 200 });
    const { totals } = await computeWindowTotals(bucket, ZONE_ID, ["2026-08-08", "2026-08-09", "2026-08-10"]);
    expect(totals.daysPresent).toBe(2);
    expect(totals.daysExpected).toBe(3);
    expect(totals.missingDays).toEqual(["2026-08-10"]);
    expect(totals.requestCount).toBe(300);
    expect(totals.bytes).toBe(120000);
  });

  it("surfaces truncated grouping sets", async () => {
    const bucket = new FakeR2();
    await seed(bucket, { "2026-08-10": 100 }, ["2026-08-10"]);
    const { totals } = await computeWindowTotals(bucket, ZONE_ID, ["2026-08-10"]);
    expect(totals.truncatedGroupingSets).toEqual(["verified_bot_country"]);
  });
});

describe("buildMonitoringMetrics", () => {
  it("computes request volume reduction when both windows are fully covered", () => {
    const pre = { daysPresent: 7, daysExpected: 7, missingDays: [], truncatedGroupingSets: [], requestCount: 10000, bytes: 0 };
    const post = { daysPresent: 7, daysExpected: 7, missingDays: [], truncatedGroupingSets: [], requestCount: 7500, bytes: 0 };
    const metrics = buildMonitoringMetrics(pre, post);
    const reduction = metrics.find((m) => m.metric === "request_volume_reduction");
    expect(reduction?.available).toBe(true);
    expect(reduction?.value).toBe(-2500);
    expect(reduction?.percentChange).toBe(-25);
  });

  it("marks every unsupported metric unavailable", () => {
    const pre = { daysPresent: 1, daysExpected: 1, missingDays: [], truncatedGroupingSets: [], requestCount: 100, bytes: 0 };
    const post = { daysPresent: 1, daysExpected: 1, missingDays: [], truncatedGroupingSets: [], requestCount: 50, bytes: 0 };
    const metrics = buildMonitoringMetrics(pre, post);
    for (const metric of [
      "rule_match_count",
      "challenge_count",
      "challenge_solve_rate",
      "search_referral_changes",
      "origin_error_rate",
      "estimated_cost_reduction",
      "likely_legitimate_traffic_exposure",
    ]) {
      const m = metrics.find((x) => x.metric === metric);
      expect(m?.available).toBe(false);
      expect(m?.value).toBeUndefined();
    }
  });

  it("does not fabricate a reduction when coverage is incomplete", () => {
    const pre = { daysPresent: 3, daysExpected: 7, missingDays: [], truncatedGroupingSets: [], requestCount: 10000, bytes: 0 };
    const post = { daysPresent: 7, daysExpected: 7, missingDays: [], truncatedGroupingSets: [], requestCount: 1000, bytes: 0 };
    const reduction = buildMonitoringMetrics(pre, post).find((m) => m.metric === "request_volume_reduction");
    expect(reduction?.available).toBe(false);
  });
});

describe("buildMonitoringReport (non-overlapping windows, due-gated)", () => {
  it("24h: exact non-uniform pre/post totals, no overlap, applied day excluded", async () => {
    const bucket = new FakeR2();
    // Non-uniform per-day counts so exact totals prove the window membership.
    await seed(bucket, {
      "2026-08-10": 1000, // pre
      "2026-08-11": 99999, // applied day — must be excluded from both windows
      "2026-08-12": 800, // post
    });
    const report = await buildMonitoringReport({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      recommendationId: "R-1042",
      cloudflareRuleId: "cf-rule-1",
      appliedAt: "2026-08-11T10:00:00Z",
      checkpoint: "24h",
      endDay: "2026-08-12",
    });
    expect(report).not.toBeNull();
    if (!report) throw new Error("expected 24h report");
    expect(report.preDays).toEqual(["2026-08-10"]);
    expect(report.postDays).toEqual(["2026-08-12"]);
    expect(report.pre.requestCount).toBe(1000);
    expect(report.post.requestCount).toBe(800);
    expect(report.preDays.some((d) => d === "2026-08-11")).toBe(false);
    expect(report.postDays.some((d) => d === "2026-08-11")).toBe(false);
    const reduction = report.metrics.find((m) => m.metric === "request_volume_reduction");
    expect(reduction?.percentChange).toBe(-20);
  });

  it("7d: exact non-uniform totals across the two full weeks, no overlap", async () => {
    const bucket = new FakeR2();
    // applied on 2026-08-11: pre = 08-04..08-10, post = 08-12..08-18
    const days: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      days[`2026-08-${String(4 + i).padStart(2, "0")}`] = 100 + i; // pre: 100..106
      days[`2026-08-${String(12 + i).padStart(2, "0")}`] = 200 + i; // post: 200..206
    }
    days["2026-08-11"] = 99999; // applied day excluded
    await seed(bucket, days);
    const report = await buildMonitoringReport({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      recommendationId: "R-1042",
      appliedAt: "2026-08-11T00:00:00Z",
      checkpoint: "7d",
      endDay: "2026-08-18",
    });
    expect(report).not.toBeNull();
    if (!report) throw new Error("expected 7d report");
    expect(report.preDays).toEqual([
      "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10",
    ]);
    expect(report.postDays).toEqual([
      "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18",
    ]);
    // Sum of 100..106 and 200..206
    expect(report.pre.requestCount).toBe(100 + 101 + 102 + 103 + 104 + 105 + 106);
    expect(report.post.requestCount).toBe(200 + 201 + 202 + 203 + 204 + 205 + 206);
    expect(report.preDays.some((d) => d === "2026-08-11")).toBe(false);
    expect(report.postDays.some((d) => d === "2026-08-11")).toBe(false);
    for (const d of report.preDays) expect(report.postDays).not.toContain(d);
    expect(report.fullCoverage).toBe(true);
  });

  it("returns null when the checkpoint is not yet due (early)", async () => {
    const bucket = new FakeR2();
    await seed(bucket, { "2026-08-10": 1000, "2026-08-11": 99999, "2026-08-12": 800 });
    const early = await buildMonitoringReport({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      recommendationId: "R-1042",
      appliedAt: "2026-08-11T00:00:00Z",
      checkpoint: "7d",
      endDay: "2026-08-17", // not yet >= 08-18
    });
    expect(early).toBeNull();
  });

  it("never backfills the post window with pre-application dates and reports missing gaps", async () => {
    const bucket = new FakeR2();
    // applied 2026-08-11, 24h: pre = 08-10 (present), post = 08-12 (MISSING).
    await seed(bucket, { "2026-08-10": 1000, "2026-08-11": 99999 });
    const report = await buildMonitoringReport({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      recommendationId: "R-1042",
      appliedAt: "2026-08-11T00:00:00Z",
      checkpoint: "24h",
      endDay: "2026-08-12",
    });
    expect(report).not.toBeNull();
    if (!report) throw new Error("expected report");
    // The post window is still 08-12 (never shifted back to 08-10/08-11).
    expect(report.postDays).toEqual(["2026-08-12"]);
    expect(report.post.daysPresent).toBe(0);
    expect(report.post.daysExpected).toBe(1);
    expect(report.post.missingDays).toEqual(["2026-08-12"]);
    expect(report.fullCoverage).toBe(false);
  });

  it("renders text and html deterministically without throwing", async () => {
    const bucket = new FakeR2();
    await seed(bucket, { "2026-08-10": 1000, "2026-08-11": 99999, "2026-08-12": 800 });
    const report = await buildMonitoringReport({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      recommendationId: "R-1042",
      appliedAt: "2026-08-11T00:00:00Z",
      checkpoint: "24h",
      endDay: "2026-08-12",
    });
    if (!report) throw new Error("expected report");
    expect(renderMonitoringText(report)).toContain("request_volume_reduction");
    expect(renderMonitoringHtml(report)).toContain("<h1>Bot Traffic Impact Report");
    expect(renderMonitoringHtml(report)).toContain("challenge_solve_rate");
  });

  it("produces a stable outcomeId and outcomeKey", () => {
    expect(outcomeId(ZONE_ID, "R-1042", "24h")).toBe(`monitor-${ZONE_ID}-R-1042-24h`);
    expect(outcomeKey(ZONE_ID, "R-1042", "7d")).toBe(`outcomes/${ZONE_ID}/R-1042/7d.json`);
  });
});