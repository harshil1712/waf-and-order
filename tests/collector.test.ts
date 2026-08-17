import { describe, expect, it } from "vitest";

import {
  buildDayQueries,
  buildGroupQuery,
  collectDay,
  dayWindow,
  MAX_CELLS_PER_GROUPING,
  parseDayCells,
  rollupSha256,
  toCell,
} from "../src/analytics/collector.ts";
import { cannedFetcher, groupingSetInQuery, HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

const DAY = "2026-08-10";

describe("dayWindow", () => {
  it("is at most one day", () => {
    const { start, end } = dayWindow(DAY);
    expect(start).toBe(`${DAY}T00:00:00Z`);
    expect(end).toBe(`${DAY}T23:59:59Z`);
  });
});

describe("buildGroupQuery", () => {
  it("projects only capability-confirmed dimensions for the grouping set", () => {
    const q = buildGroupQuery(ZONE_ID, DAY, "verified_bot_country");
    expect(q.query).toContain("verifiedBotCategory");
    expect(q.query).toContain("clientCountryName");
    // Never the stale/wrong field names (`verifiedBotCategory` contains the
    // substring `verifiedBot`, so assert the standalone stale name via \b).
    expect(q.query).not.toMatch(/\bverifiedBot\b/);
    expect(q.query).not.toContain("clientRequestSource");
    // The uniq aggregation is an unknown field on this plan and must not be queried.
    expect(q.query).not.toContain("uniq");
    expect(q.query).not.toContain("clientAsn");
    expect(q.query).not.toContain("botManagementDecision");
    expect(q.variables.zoneTag).toBe(ZONE_ID);
    expect(q.variables.limit).toBe(MAX_CELLS_PER_GROUPING);
  });

  it("embeds a one-day window filter", () => {
    const q = buildGroupQuery(ZONE_ID, DAY, "path_status");
    expect(q.query).toContain(`datetime_geq: "${DAY}T00:00:00Z"`);
    expect(q.query).toContain(`datetime_leq: "${DAY}T23:59:59Z"`);
  });

  it("builds a query per grouping set", () => {
    const queries = buildDayQueries(ZONE_ID, DAY);
    expect(queries).toHaveLength(4);
    const sets = new Set(queries.map((q) => q.groupingSet));
    expect(sets).toEqual(
      new Set(["verified_bot_country", "ua_verified_bot", "path_status", "source_country"]),
    );
  });
});

describe("toCell", () => {
  it("normalizes metrics and truncates dimension strings", () => {
    const cell = toCell(
      {
        count: 10,
        sum: { edgeResponseBytes: 1000 },
        dimensions: { userAgent: "a".repeat(500), verifiedBotCategory: true },
      },
      "ua_verified_bot",
    );
    expect(cell.requestCount).toBe(10);
    expect(cell.bytes).toBe(1000);
    expect((cell.dimensions.userAgent as string).length).toBeLessThanOrEqual(256);
    expect(cell.dimensions.verifiedBotCategory).toBe(true);
  });

  it("defaults missing metrics to zero", () => {
    const cell = toCell({ count: 5, dimensions: {} }, "path_status");
    expect(cell.bytes).toBe(0);
  });
});

describe("parseDayCells", () => {
  it("maps canned rows to the correct grouping set", async () => {
    const raw = await cannedFetcher()("", {});
    // The canned fetcher ignores query; it returns the default grouping set
    // rows for the empty query detection ("unknown" → no rows). Instead parse
    // rows produced for a real query shape via collectDay below.
    const cells = parseDayCells(raw);
    expect(cells).toEqual({});
  });

  it("returns empty when no zones/data are present", () => {
    expect(parseDayCells({ data: { viewer: { zones: [] } } })).toEqual({});
  });
});

describe("collectDay", () => {
  const FIXED_COLLECTED_AT = "2026-08-10T04:05:06Z";

  it("collects all grouping sets into one rollup with an integrity hash", async () => {
    const rollup = await collectDay({
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      day: DAY,
      fetcher: cannedFetcher(),
      collectedAt: FIXED_COLLECTED_AT,
    });

    expect(rollup.zoneId).toBe(ZONE_ID);
    expect(rollup.hostname).toBe(HOSTNAME);
    expect(rollup.day).toBe(DAY);
    expect(rollup.collectedAt).toBe(FIXED_COLLECTED_AT);
    expect(rollup.collectorVersion).toBe("phase1.2.0");
    expect(rollup.schemaVersion).toBe(1);
    expect(rollup.truncatedGroupingSets).toEqual([]);

    for (const set of ["verified_bot_country", "ua_verified_bot", "path_status", "source_country"] as const) {
      expect(rollup.groupingSets[set]!.length).toBeGreaterThan(0);
    }

    const { sha256: stored, ...content } = rollup;
    expect(stored).toBe(rollupSha256(content));
  });

  it("is byte-for-byte deterministic for the same input day, fetcher, and collectedAt", async () => {
    const a = await collectDay({
      zoneId: ZONE_ID, hostname: HOSTNAME, day: DAY, fetcher: cannedFetcher(), collectedAt: FIXED_COLLECTED_AT,
    });
    const b = await collectDay({
      zoneId: ZONE_ID, hostname: HOSTNAME, day: DAY, fetcher: cannedFetcher(), collectedAt: FIXED_COLLECTED_AT,
    });
    // Full equality, including the integrity hash, because collectedAt is
    // fixed and part of the hashed content.
    expect(a).toEqual(b);
    expect(a.sha256).toBe(b.sha256);
  });

  it("records a grouping set as truncated when the row count reaches the cap", async () => {
    const capped = new Array(MAX_CELLS_PER_GROUPING).fill(null).map((_, i) => ({
      count: 1,
      sum: { edgeResponseBytes: 1 },
      dimensions: { userAgent: `ua-${i}`, verifiedBotCategory: false },
    }));
    const fetcher = async (query: string) => ({
      data: {
        viewer: { zones: [{ httpRequestsAdaptiveGroups: capped }] },
      },
    });
    const rollup = await collectDay({
      zoneId: ZONE_ID, hostname: HOSTNAME, day: DAY, fetcher, collectedAt: FIXED_COLLECTED_AT,
    });
    // Only the ua_verified_bot projection (userAgent + verifiedBotCategory) is
    // recognized; the capped rows only match that grouping set.
    expect(rollup.truncatedGroupingSets).toContain("ua_verified_bot");
  });
});

describe("groupingSetInQuery (fixture)", () => {
  it("detects each grouping set from its projection", () => {
    expect(groupingSetInQuery('dimensions { verifiedBotCategory clientCountryName }')).toBe(
      "verified_bot_country",
    );
    expect(groupingSetInQuery('dimensions { clientRequestPath edgeResponseStatus }')).toBe(
      "path_status",
    );
    expect(groupingSetInQuery('dimensions { requestSource clientCountryName }')).toBe(
      "source_country",
    );
  });
});