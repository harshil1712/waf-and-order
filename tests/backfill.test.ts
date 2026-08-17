import { describe, expect, it } from "vitest";

import {
  addDays,
  computeMissingDays,
  DEFAULT_BACKFILL_WINDOW_DAYS,
  daysInRange,
  runBoundedBackfill,
  windowStart,
} from "../src/analytics/backfill.ts";
import { listRollupDays, rollupKey } from "../src/analytics/storage.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { cannedFetcher, HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

describe("addDays / daysInRange / windowStart", () => {
  it("adds and subtracts calendar days in UTC", () => {
    expect(addDays("2026-08-10", 1)).toBe("2026-08-11");
    expect(addDays("2026-08-10", -1)).toBe("2026-08-09");
  });

  it("lists inclusive day ranges", () => {
    expect(daysInRange("2026-08-08", "2026-08-10")).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
  });

  it("computes a bounded window start", () => {
    expect(windowStart("2026-08-14", 7)).toBe("2026-08-08");
  });
});

describe("computeMissingDays", () => {
  it("returns only days within the window that are missing, oldest first", () => {
    const existing = new Set(["2026-08-09", "2026-08-11"]);
    expect(computeMissingDays(existing, "2026-08-08", "2026-08-12")).toEqual([
      "2026-08-08",
      "2026-08-10",
      "2026-08-12",
    ]);
  });

  it("returns nothing when every day is present", () => {
    const existing = new Set(["2026-08-10", "2026-08-11", "2026-08-12"]);
    expect(computeMissingDays(existing, "2026-08-10", "2026-08-12")).toEqual([]);
  });
});

describe("runBoundedBackfill", () => {
  it("backfills missing days within the bounded window", async () => {
    const bucket = new FakeR2();
    // Seed one day so it is not backfilled.
    const existingDay = "2026-08-10";
    bucket.objects.set(rollupKey(ZONE_ID, existingDay), {
      body: JSON.stringify({ day: existingDay }),
      metadata: {},
    });

    const endDay = "2026-08-12";
    const backfilled = await runBoundedBackfill({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      endDay,
      windowDays: 3,
      fetcher: cannedFetcher(),
    });

    // Window is 08-10..08-12; 08-10 already present, so 08-11 and 08-12 backfilled.
    expect(backfilled.sort()).toEqual(["2026-08-11", "2026-08-12"]);

    const days = await listRollupDays(bucket, ZONE_ID);
    expect(days).toEqual(new Set(["2026-08-10", "2026-08-11", "2026-08-12"]));
  });

  it("is bounded: never considers days older than the window", async () => {
    const bucket = new FakeR2();
    const endDay = "2026-08-12";
    await runBoundedBackfill({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      endDay,
      windowDays: 2,
      fetcher: cannedFetcher(),
    });
    const days = await listRollupDays(bucket, ZONE_ID);
    // Only 08-11 and 08-12 within a 2-day window ending 08-12.
    expect(days).toEqual(new Set(["2026-08-11", "2026-08-12"]));
    expect(DEFAULT_BACKFILL_WINDOW_DAYS).toBe(14);
  });

  it("writes valid, verifiable rollups", async () => {
    const bucket = new FakeR2();
    await runBoundedBackfill({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      endDay: "2026-08-11",
      windowDays: 2,
      fetcher: cannedFetcher(),
    });
    for (const day of ["2026-08-10", "2026-08-11"]) {
      const rollup = await (async () => {
        const obj = await bucket.get(rollupKey(ZONE_ID, day));
        return obj ? obj.json<{ sha256?: string }>() : null;
      })();
      expect(rollup).not.toBeNull();
      if (!rollup) throw new Error("expected rollup");
      expect(rollup.sha256).toBeTruthy();
    }
  });
});