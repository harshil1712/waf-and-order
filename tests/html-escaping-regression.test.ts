import { describe, expect, it } from "vitest";

import { buildWeeklyReport, renderReportHtml } from "../src/analytics/report.ts";
import { escapeHtml } from "../src/analytics/sanitization.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import { sha256 } from "../src/shared/canonical.ts";

/**
 * HTML-escaping regression.
 * Traffic-derived fields (path, user agent, referrer, hostname) are untrusted
 * input. The rendered report must never contain raw markup from them.
 */

const ZONE_ID = "zone-abc";
const HOSTNAME = "example.com";

function rollupWith(ua: string, path: string): DailyRollup {
  const rollup: Omit<DailyRollup, "sha256"> = {
    schemaVersion: 1,
    zoneId: ZONE_ID,
    hostname: HOSTNAME,
    day: "2026-08-13",
    periodStart: "2026-08-13T00:00:00Z",
    periodEnd: "2026-08-13T23:59:59Z",
    collectedAt: "2026-08-13T04:00:00Z",
    collectorVersion: "phase1.2.0",
    groupingSets: {
      ua_verified_bot: [
        { groupingSet: "ua_verified_bot", dimensions: { userAgent: ua, verifiedBotCategory: false }, requestCount: 1, bytes: 1 },
      ],
      path_status: [
        { groupingSet: "path_status", dimensions: { clientRequestPath: path, edgeResponseStatus: 200 }, requestCount: 1, bytes: 1 },
      ],
    },
    truncatedGroupingSets: [],
  };
  return { ...rollup, sha256: sha256(rollup) };
}

describe("HTML-escaping regression: report render", () => {
  const UA = `<img src=x onerror="alert(1)">bot`;
  const PATH = `/<script>alert('x')</script>profile?q="&'`;

  it("never emits raw markup from user-agent or path", () => {
    const report = buildWeeklyReport([rollupWith(UA, PATH)], {
      zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z",
    });
    const html = renderReportHtml(report);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the hostname header when it is attacker-controlled", () => {
    const evilHost = `evil" onload="alert(1)`;
    const report = buildWeeklyReport([rollupWith("ua", "/")], {
      zoneId: ZONE_ID, hostname: evilHost, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z",
    });
    const html = renderReportHtml(report);
    expect(html).not.toContain(`evil" onload="alert(1)`);
    expect(html).toContain("&quot;");
  });
});

describe("HTML-escaping regression: primitives", () => {
  it("escapeHtml is total for the five risky characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});