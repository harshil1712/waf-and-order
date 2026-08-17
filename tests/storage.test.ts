import { describe, expect, it } from "vitest";

import {
  dayFromRollupKey,
  listRollupDays,
  listRollupKeys,
  readDayRollup,
  readRollupForDay,
  rollupKey,
  verifyRollupIntegrity,
  writeDayRollup,
} from "../src/analytics/storage.ts";
import { sha256 } from "../src/shared/canonical.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { HOSTNAME, makeRollup, ZONE_ID } from "./helpers/fixtures.ts";

describe("rollupKey / dayFromRollupKey", () => {
  it("produces a deterministic key and round-trips the day", () => {
    const key = rollupKey(ZONE_ID, "2026-08-10");
    expect(key).toBe(`rollups/${ZONE_ID}/2026-08-10.json`);
    expect(dayFromRollupKey(key)).toBe("2026-08-10");
  });

  it("returns null for a non-rollup key", () => {
    expect(dayFromRollupKey("rollups/other/not-a-day.json")).toBeNull();
    expect(dayFromRollupKey("other.txt")).toBeNull();
  });
});

describe("verifyRollupIntegrity", () => {
  it("accepts a rollup whose hash matches its canonical content", () => {
    const { sha256: _h, ...content } = makeRollup("2026-08-10");
    const rollup = { ...content, sha256: sha256(content) };
    expect(() => verifyRollupIntegrity(rollup)).not.toThrow();
  });

  it("throws when the stored hash does not match the content", () => {
    const rollup = makeRollup("2026-08-10");
    rollup.sha256 = "f".repeat(64);
    expect(() => verifyRollupIntegrity(rollup)).toThrow(/integrity/);
  });

  it("throws when the hash is missing", () => {
    const { sha256: _h, ...content } = makeRollup("2026-08-10");
    expect(() => verifyRollupIntegrity(content as never)).toThrow(/missing a sha256/);
  });
});

describe("writeDayRollup + readDayRollup", () => {
  it("writes idempotently (overwrite, not append) for the same day", async () => {
    const bucket = new FakeR2();
    const first = makeRollup("2026-08-10");
    const { sha256: _a, ...c1 } = first;
    first.sha256 = sha256(c1);

    await writeDayRollup(bucket, first);
    await writeDayRollup(bucket, first); // retry converges

    const keys = await listRollupKeys(bucket, ZONE_ID);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(rollupKey(ZONE_ID, "2026-08-10"));

    const read = await readRollupForDay(bucket, ZONE_ID, "2026-08-10");
    expect(read).not.toBeNull();
    if (!read) throw new Error("expected rollup");
    expect(read.day).toBe("2026-08-10");
  });

  it("returns null for a missing day", async () => {
    const bucket = new FakeR2();
    expect(await readRollupForDay(bucket, ZONE_ID, "2026-01-01")).toBeNull();
    expect(await readDayRollup(bucket, rollupKey(ZONE_ID, "2026-01-01"))).toBeNull();
  });

  it("throws on read when a stored rollup is corrupt", async () => {
    const bucket = new FakeR2();
    const rollup = makeRollup("2026-08-10");
    const { sha256: _h, ...content } = rollup;
    rollup.sha256 = sha256(content);

    await writeDayRollup(bucket, rollup);
    // Tamper with the stored body so the hash no longer matches.
    const key = rollupKey(ZONE_ID, "2026-08-10");
    const parsed = JSON.parse(bucket.raw(key)!);
    parsed.groupingSets = {};
    bucket.objects.set(key, { body: JSON.stringify(parsed), metadata: {} });

    await expect(readRollupForDay(bucket, ZONE_ID, "2026-08-10")).rejects.toThrow(/integrity/);
  });
});

describe("listRollupDays", () => {
  it("lists distinct stored days for a zone", async () => {
    const bucket = new FakeR2();
    for (const day of ["2026-08-08", "2026-08-09", "2026-08-10"]) {
      const rollup = makeRollup(day);
      const { sha256: _h, ...content } = rollup;
      rollup.sha256 = sha256(content);
      await writeDayRollup(bucket, rollup);
    }
    const days = await listRollupDays(bucket, ZONE_ID);
    expect(days).toEqual(new Set(["2026-08-08", "2026-08-09", "2026-08-10"]));
  });

  it("does not cross zone prefixes", async () => {
    const bucket = new FakeR2();
    const rollup = makeRollup("2026-08-10");
    const { sha256: _h, ...content } = rollup;
    rollup.sha256 = sha256(content);
    await writeDayRollup(bucket, rollup);
    const other = { ...rollup, zoneId: "zone-other" };
    await writeDayRollup(bucket, other);
    expect(await listRollupDays(bucket, ZONE_ID)).toEqual(new Set(["2026-08-10"]));
    expect(await listRollupDays(bucket, "zone-other")).toEqual(new Set(["2026-08-10"]));
  });
});