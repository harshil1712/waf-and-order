import { describe, expect, it, vi } from "vitest";

import { summarizeRollups } from "../src/tools/read-history.ts";
import { createSendReportTool } from "../src/tools/send-report.ts";
import { sha256 } from "../src/shared/canonical.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import { HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

/** Minimal stub satisfying the tool context for tests. */
function fakeContext(data: unknown) {
  return {
    toolCallId: "call-1",
    signal: undefined,
    log: {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
    data,
  } as never;
}

function rollupWithUa(day: string, userAgent: string): DailyRollup {
  const rollup: Omit<DailyRollup, "sha256"> = {
    schemaVersion: 1,
    zoneId: ZONE_ID,
    hostname: HOSTNAME,
    day,
    periodStart: `${day}T00:00:00Z`,
    periodEnd: `${day}T23:59:59Z`,
    collectedAt: `${day}T04:00:00Z`,
    collectorVersion: "phase1.2.0",
    groupingSets: {
      ua_verified_bot: [
        { groupingSet: "ua_verified_bot", dimensions: { userAgent, verifiedBotCategory: true }, requestCount: 10, bytes: 100 },
      ],
      verified_bot_country: [],
      path_status: [],
      source_country: [],
    },
    truncatedGroupingSets: [],
  };
  return { ...rollup, sha256: sha256(rollup) };
}

describe("summarizeRollups (read-history tool logic)", () => {
  it("groups cells by grouping set and bounds output", () => {
    const ua = "Googlebot" + "x".repeat(300); // overlong → truncated
    const rollups = [rollupWithUa("2026-08-13", ua), rollupWithUa("2026-08-14", ua)];
    const summary = summarizeRollups(rollups);

    const uaRows = summary["ua_verified_bot"];
    expect(uaRows).toHaveLength(1); // merged identical dims
    expect(uaRows[0].requestCount).toBe(20);
    expect((uaRows[0].dimensions.userAgent as string).length).toBeLessThanOrEqual(256);
  });
});

describe("createSendReportTool (mockable delivery)", () => {
  it("passes rendered report to the injected sender", async () => {
    const send = vi.fn(
      async (req: { reportId: string; subject: string; zoneId: string }) => ({
        sent: true,
        transport: "fake",
        detail: req.subject,
        reportId: req.reportId,
      }),
    );
    const sender = { send };
    const tool = createSendReportTool({ zoneId: ZONE_ID, hostname: HOSTNAME, sender });

    const result = await tool.run(
      fakeContext({
        reportId: "report-1",
        html: "<html></html>",
        text: "hello",
        endDay: "2026-08-13",
      }),
    );

    const output = (result as { output: { sent: boolean; transport: string } }).output;
    expect(output.sent).toBe(true);
    expect(output.transport).toBe("fake");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].zoneId).toBe(ZONE_ID);
    expect(send.mock.calls[0][0].reportId).toBe("report-1");
  });
});