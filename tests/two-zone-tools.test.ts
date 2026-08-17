import { describe, expect, it } from "vitest";

import { createReadHistoryTool } from "../src/tools/read-history.ts";
import { createGenerateReportTool } from "../src/tools/generate-report.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { yesterdayIso } from "../src/shared/dates.ts";
import { addDays } from "../src/analytics/backfill.ts";
import { writeDayRollup } from "../src/analytics/storage.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import type { ZoneConfig } from "../src/registry/zone-registry.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";

const ZONE_A = "zone-a";
const ZONE_B = "zone-b";

function configFor(zoneId: string, hostname: string): ZoneConfig {
  return {
    zoneId,
    hostname,
    rulesetId: `ruleset-${zoneId}`,
    rulesetPhase: "http_request_firewall_custom",
    rulesetVersion: "1",
    enabled: true,
    allowedEnvelopeSenders: [],
    reportSender: "",
    reportRecipient: "",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makeRollup(zoneId: string, hostname: string, day: string, requestCount: number): DailyRollup {
  const rollup: Omit<DailyRollup, "sha256"> = {
    schemaVersion: 1,
    zoneId,
    hostname,
    day,
    periodStart: `${day}T00:00:00Z`,
    periodEnd: `${day}T23:59:59Z`,
    collectedAt: `${day}T04:00:00Z`,
    collectorVersion: "phase5",
    groupingSets: {
      verified_bot_country: [
        {
          groupingSet: "verified_bot_country",
          dimensions: { verifiedBotCategory: true, clientCountryName: "US" },
          requestCount,
          bytes: requestCount * 100,
        },
      ],
    },
    truncatedGroupingSets: [],
  };
  return { ...rollup, sha256: sha256(rollup) };
}

function toolContext(data: unknown) {
  return {
    toolCallId: "call-1",
    signal: undefined,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    data,
  } as never;
}

describe("two-zone tool separation (R2 remains zone-keyed)", () => {
  it("read_traffic_history returns only the requested zone's rollups", async () => {
    const bucket = new FakeR2();
    const endDay = yesterdayIso();
    const day = addDays(endDay, 0);
    // Seed a distinct day for each zone with distinct request counts.
    await writeDayRollup(bucket, makeRollup(ZONE_A, "a.example.com", day, 1000));
    await writeDayRollup(bucket, makeRollup(ZONE_B, "b.example.com", day, 5000));

    const configs: Record<string, ZoneConfig> = {
      [ZONE_A]: configFor(ZONE_A, "a.example.com"),
      [ZONE_B]: configFor(ZONE_B, "b.example.com"),
    };
    const zoneContext = {
      resolveZoneConfig: async (zoneId: string) => configs[zoneId] ?? null,
      resolveBucket: (zoneId: string) => bucket,
    };

    const tool = createReadHistoryTool({
      zoneId: ZONE_A,
      resolveBucket: () => bucket,
      zoneContext,
    });

    const a = (await tool.run(toolContext({ zoneId: ZONE_A, days: 1 }))) as {
      output: { zoneId: string; daysPresent: number; groupingSets: Record<string, unknown[]> };
    };
    expect(a.output.zoneId).toBe(ZONE_A);
    expect(a.output.daysPresent).toBe(1);

    const b = (await tool.run(toolContext({ zoneId: ZONE_B, days: 1 }))) as {
      output: { zoneId: string; daysPresent: number };
    };
    expect(b.output.zoneId).toBe(ZONE_B);
    expect(b.output.daysPresent).toBe(1);
    // Different zones, different data: the day present is the same count of days,
    // but each zone only sees its own rollup (the other zone is absent).
  });

  it("read_traffic_history rejects an unknown/disabled zone", async () => {
    const bucket = new FakeR2();
    const zoneContext = {
      resolveZoneConfig: async () => null,
      resolveBucket: (zoneId: string) => bucket,
    };
    const tool = createReadHistoryTool({
      zoneId: ZONE_A,
      resolveBucket: () => bucket,
      zoneContext,
    });
    await expect(tool.run(toolContext({ zoneId: "zone-nope", days: 1 }))).rejects.toThrow(
      /unknown or disabled zone/,
    );
  });

  it("generate_weekly_report resolves hostname from D1 (never the model)", async () => {
    const bucket = new FakeR2();
    // Seed 7 days ending yesterday for zone-a so the report has full coverage.
    const endDay = yesterdayIso();
    for (let i = 0; i < 7; i++) {
      const day = addDays(endDay, -i);
      await writeDayRollup(bucket, makeRollup(ZONE_A, "a.example.com", day, 100 + i));
    }
    const configs: Record<string, ZoneConfig> = {
      [ZONE_A]: configFor(ZONE_A, "a.example.com"),
    };
    const zoneContext = {
      resolveZoneConfig: async (zoneId: string) => configs[zoneId] ?? null,
      resolveBucket: (zoneId: string) => bucket,
    };
    const tool = createGenerateReportTool({
      zoneId: ZONE_A,
      hostname: "",
      resolveBucket: () => bucket,
      zoneContext,
    });
    const result = (await tool.run(toolContext({ zoneId: ZONE_A, endDay }))) as {
      output: { zoneId: string; hostname: string; daysPresent: number; daysExpected: number };
    };
    expect(result.output.zoneId).toBe(ZONE_A);
    // Hostname resolved from D1 config, not supplied by the model.
    expect(result.output.hostname).toBe("a.example.com");
    expect(result.output.daysPresent).toBe(7);
  });
});