import { describe, expect, it } from "vitest";

import { lastNDays, readHistory, SEVEN_DAY_WINDOW } from "../src/analytics/reader.ts";
import { rollupKey, writeDayRollup } from "../src/analytics/storage.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { HOSTNAME, makeRollup, ZONE_ID } from "./helpers/fixtures.ts";

describe("lastNDays", () => {
  it("lists the last N days inclusive, oldest first", () => {
    expect(lastNDays("2026-08-14", 7)).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
  });
});

describe("readHistory", () => {
  it("reads exactly SEVEN_DAY_WINDOW days ending at endDay", async () => {
    const bucket = new FakeR2();
    for (const day of lastNDays("2026-08-14", 7)) {
      const rollup = makeRollup(day);
      const { sha256: _h, ...content } = rollup;
      rollup.sha256 = sha256(content);
      await writeDayRollup(bucket, rollup);
    }

    const { rollups, missingDays } = await readHistory(bucket, ZONE_ID, "2026-08-14");
    expect(SEVEN_DAY_WINDOW).toBe(7);
    expect(rollups).toHaveLength(7);
    expect(missingDays).toEqual([]);
  });

  it("skips and reports missing days instead of fabricating them", async () => {
    const bucket = new FakeR2();
    // Only seed 2 of the 7 days.
    for (const day of ["2026-08-12", "2026-08-14"]) {
      const rollup = makeRollup(day);
      const { sha256: _h, ...content } = rollup;
      rollup.sha256 = sha256(content);
      await writeDayRollup(bucket, rollup);
    }

    const { rollups, missingDays } = await readHistory(bucket, ZONE_ID, "2026-08-14");
    expect(rollups.map((r) => r.day)).toEqual(["2026-08-12", "2026-08-14"]);
    expect(missingDays).toEqual(["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-13"]);
  });

  it("supports a custom window length", async () => {
    const bucket = new FakeR2();
    const rollup = makeRollup("2026-08-14");
    const { sha256: _h, ...content } = rollup;
    rollup.sha256 = sha256(content);
    await writeDayRollup(bucket, rollup);

    const { rollups } = await readHistory(bucket, ZONE_ID, "2026-08-14", 3);
    expect(rollups).toHaveLength(1);
  });

  it("throws on a corrupt stored rollup", async () => {
    const bucket = new FakeR2();
    const day = "2026-08-14";
    bucket.objects.set(rollupKey(ZONE_ID, day), {
      body: JSON.stringify({ day, sha256: "f".repeat(64) }),
      metadata: {},
    });
    await expect(readHistory(bucket, ZONE_ID, "2026-08-14", 1)).rejects.toThrow(/integrity/);
  });
});