import { describe, expect, it } from "vitest";

import { collectDay } from "../src/analytics/collector.ts";
import { writeDayRollup, listRollupDays, rollupKey } from "../src/analytics/storage.ts";
import { runBoundedBackfill } from "../src/analytics/backfill.ts";
import { readHistory } from "../src/analytics/reader.ts";
import { buildWeeklyReport, renderReportHtml, renderReportText } from "../src/analytics/report.ts";
import { addDays } from "../src/analytics/backfill.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { cannedFetcher, HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

describe("end-to-end: collection → R2 → reader → weekly report", () => {
  it("collects 7 days, stores idempotently, and renders a report", async () => {
    const bucket = new FakeR2();
    const fetcher = cannedFetcher();
    const endDay = "2026-08-14";

    // 1. Daily collection for each of the last 7 days.
    for (let i = 6; i >= 0; i--) {
      const day = addDays(endDay, -i);
      const rollup = await collectDay({ zoneId: ZONE_ID, hostname: HOSTNAME, day, fetcher });
      await writeDayRollup(bucket, rollup);
    }

    expect((await listRollupDays(bucket, ZONE_ID)).size).toBe(7);

    // 2. Idempotent overwrite: re-collecting the same day converges on one object.
    const again = await collectDay({ zoneId: ZONE_ID, hostname: HOSTNAME, day: endDay, fetcher });
    await writeDayRollup(bucket, again);
    expect((await listRollupDays(bucket, ZONE_ID)).size).toBe(7);
    expect(bucket.raw(rollupKey(ZONE_ID, endDay))).toBeTruthy();

    // 3. Seven-day reader returns exactly the seeded days, none missing.
    const { rollups, missingDays } = await readHistory(bucket, ZONE_ID, endDay, 7);
    expect(rollups).toHaveLength(7);
    expect(missingDays).toEqual([]);

    // 4. Weekly report aggregates and renders both versions.
    const startDay = addDays(endDay, -6);
    const report = buildWeeklyReport(rollups, {
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      startDay,
      endDay,
      generatedAt: `${endDay}T05:00:00Z`,
    });
    expect(report.daysPresent).toBe(7);
    expect(report.daysExpected).toBe(7);
    expect(report.totalRequests).toBeGreaterThan(0);

    const html = renderReportHtml(report);
    const text = renderReportText(report);
    expect(html).toContain(`Window: ${startDay} .. ${endDay}`);
    expect(text).toContain(`Window: ${startDay} .. ${endDay}`);
  });

  it("backfills gaps after a partial outage within the bounded window", async () => {
    const bucket = new FakeR2();
    const fetcher = cannedFetcher();
    const endDay = "2026-08-14";

    // Outage: only 2 of 7 days were collected.
    for (const day of ["2026-08-12", "2026-08-14"]) {
      const rollup = await collectDay({ zoneId: ZONE_ID, hostname: HOSTNAME, day, fetcher });
      await writeDayRollup(bucket, rollup);
    }

    const backfilled = await runBoundedBackfill({
      bucket,
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      endDay,
      windowDays: 7,
      fetcher,
    });

    expect(backfilled.sort()).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
      "2026-08-11",
      "2026-08-13",
    ]);

    const days = await listRollupDays(bucket, ZONE_ID);
    expect(days).toEqual(new Set(["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]));
  });
});