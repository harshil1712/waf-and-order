import { describe, expect, it } from "vitest";

import {
  outcomeFromReport,
  outcomeKey,
  writeOutcome,
} from "../src/analytics/outcome-storage.ts";
import type { MonitoringReport } from "../src/analytics/monitor.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

function report(checkpoint: "24h" | "7d"): MonitoringReport {
  return {
    zoneId: ZONE_ID,
    hostname: HOSTNAME,
    recommendationId: "R-1042",
    cloudflareRuleId: "cf-rule-1",
    appliedAt: "2026-08-11T10:00:00Z",
    checkpoint,
    endDay: "2026-08-12",
    preDays: ["2026-08-10"],
    postDays: ["2026-08-12"],
    pre: {
      daysPresent: 1,
      daysExpected: 1,
      missingDays: [],
      truncatedGroupingSets: [],
      requestCount: 1000,
      bytes: 400000,
    },
    post: {
      daysPresent: 1,
      daysExpected: 1,
      missingDays: [],
      truncatedGroupingSets: [],
      requestCount: 800,
      bytes: 320000,
    },
    metrics: [
      { metric: "request_count", available: true, value: 800, reason: "post count" },
      { metric: "rule_match_count", available: false, reason: "unavailable" },
    ],
    fullCoverage: true,
  };
}

describe("outcomeKey", () => {
  it("produces a deterministic key", () => {
    expect(outcomeKey(ZONE_ID, "R-1042", "24h")).toBe(`outcomes/${ZONE_ID}/R-1042/24h.json`);
    expect(outcomeKey(ZONE_ID, "R-1042", "7d")).toBe(`outcomes/${ZONE_ID}/R-1042/7d.json`);
  });
});

describe("outcomeFromReport", () => {
  it("captures supported and unavailable metrics separately", () => {
    const outcome = outcomeFromReport(report("24h"), "2026-08-11T12:00:00Z");
    expect(outcome.supportedMetrics).toEqual([{ metric: "request_count", value: 800 }]);
    expect(outcome.unavailableMetrics).toContain("rule_match_count");
    expect(outcome.pre.requestCount).toBe(1000);
    expect(outcome.post.requestCount).toBe(800);
  });
});

describe("writeOutcome", () => {
  it("writes idempotently (overwrite) to a deterministic key with a valid integrity hash", async () => {
    const bucket = new FakeR2();
    const key = await writeOutcome(bucket, report("24h"), "2026-08-11T12:00:00Z");
    expect(key).toBe(`outcomes/${ZONE_ID}/R-1042/24h.json`);
    await writeOutcome(bucket, report("24h"), "2026-08-11T12:00:00Z");
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((k) => k.startsWith("outcomes/"))).toHaveLength(1);

    const stored = JSON.parse(bucket.raw(key)!);
    expect(stored.recommendationId).toBe("R-1042");
    expect(stored.checkpoint).toBe("24h");
    const { sha256: hash, ...content } = stored;
    expect(hash).toBe(sha256(content));
  });

  it("separates checkpoints into distinct keys", async () => {
    const bucket = new FakeR2();
    await writeOutcome(bucket, report("24h"), "2026-08-11T12:00:00Z");
    await writeOutcome(bucket, report("7d"), "2026-08-11T12:00:00Z");
    const outcomeKeys = [...bucket.objects.keys()].filter((k) => k.startsWith("outcomes/"));
    expect(outcomeKeys).toHaveLength(2);
    expect(outcomeKeys).toContain(`outcomes/${ZONE_ID}/R-1042/24h.json`);
    expect(outcomeKeys).toContain(`outcomes/${ZONE_ID}/R-1042/7d.json`);
  });
});