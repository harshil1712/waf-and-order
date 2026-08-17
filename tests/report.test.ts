import { describe, expect, it } from "vitest";

import {
  buildWeeklyReport,
  renderReportHtml,
  renderReportText,
  reportIdFor,
} from "../src/analytics/report.ts";
import { CAPABILITY_MATRIX, supportedMetrics } from "../src/analytics/capability.ts";
import { sha256 } from "../src/shared/canonical.ts";
import type { DailyRollup } from "../src/analytics/types.ts";
import { HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

/** Build a rollup with adversarial user-agent/path strings for one day. */
function adversarialRollup(day: string, ua: string, path: string, truncated: boolean = false): DailyRollup {
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
      verified_bot_country: [
        { groupingSet: "verified_bot_country", dimensions: { verifiedBotCategory: false, clientCountryName: "US" }, requestCount: 500, bytes: 200000 },
      ],
      ua_verified_bot: [
        { groupingSet: "ua_verified_bot", dimensions: { userAgent: ua, verifiedBotCategory: false }, requestCount: 500, bytes: 200000 },
      ],
      path_status: [
        { groupingSet: "path_status", dimensions: { clientRequestPath: path, edgeResponseStatus: 200 }, requestCount: 500, bytes: 200000 },
      ],
      source_country: [
        { groupingSet: "source_country", dimensions: { requestSource: "eyeball", clientCountryName: "US" }, requestCount: 500, bytes: 200000 },
      ],
    },
    truncatedGroupingSets: truncated ? ["path_status"] : [],
  };
  return { ...rollup, sha256: sha256(rollup) };
}

describe("buildWeeklyReport", () => {
  const rollups = [adversarialRollup("2026-08-12", "Googlebot", "/"), adversarialRollup("2026-08-13", "Googlebot", "/")];

  it("aggregates capability-supported metrics", () => {
    const report = buildWeeklyReport(rollups, {
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      startDay: "2026-08-07",
      endDay: "2026-08-13",
      generatedAt: "2026-08-13T05:00:00Z",
    });
    expect(report.daysPresent).toBe(2);
    expect(report.daysExpected).toBe(7);
    expect(report.missingDays).toHaveLength(5);
    expect(report.totalRequests).toBe(1000);
    expect(report.totalBytes).toBe(400000);
  });

  it("produces a stable report id", () => {
    expect(reportIdFor(ZONE_ID, "2026-08-13", "2026-08-07")).toBe(
      `report-${ZONE_ID}-2026-08-07-2026-08-13`,
    );
  });

  it("keeps only capability-supported metric observations", () => {
    const report = buildWeeklyReport(rollups, {
      zoneId: ZONE_ID,
      hostname: HOSTNAME,
      startDay: "2026-08-07",
      endDay: "2026-08-13",
      generatedAt: "2026-08-13T05:00:00Z",
    });
    const metrics = report.observations.map((o) => o.metric);
    expect(metrics).toContain("request_count");
    expect(metrics).toContain("bytes");
    // unique_ips_estimate is unsupported (uniq is an unknown field) and must
    // never appear as an observation.
    expect(metrics).not.toContain("unique_ips_estimate");
    const supported = new Set(supportedMetrics());
    for (const obs of report.observations) {
      expect(supported.has(obs.metric)).toBe(true);
    }
  });

  it("surfaces grouping sets truncated at collection time", () => {
    const report = buildWeeklyReport(
      [adversarialRollup("2026-08-13", "Googlebot", "/", true)],
      { zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z" },
    );
    expect(report.truncatedGroupingSets).toContain("path_status");
    const text = renderReportText(report);
    expect(text).toMatch(/Truncated grouping sets \(totals incomplete\): path_status/);
    const html = renderReportHtml(report);
    expect(html).toMatch(/Truncated grouping sets \(totals incomplete\)/);
    expect(html).toContain("path_status");
  });
});

describe("report capability matrix", () => {
  it("explicitly omits unsupported metrics", () => {
    const omitted = CAPABILITY_MATRIX.filter((c) => !c.supported).map((c) => c.metric);
    expect(omitted).toContain("sequential_traversal_score");
    expect(omitted).toContain("distributed_ip_correlation");
    expect(omitted).toContain("challenge_solve_rate");
    expect(omitted).toContain("unique_ips_estimate");
    const supported = new Set(supportedMetrics());
    expect(supported.has("sequential_traversal_score")).toBe(false);
    expect(supported.has("unique_ips_estimate")).toBe(false);
    expect(supported.has("request_count")).toBe(true);
  });
});

describe("renderReportText", () => {
  it("renders coverage, metrics, and omitted capabilities", () => {
    const report = buildWeeklyReport(
      [adversarialRollup("2026-08-13", "Googlebot", "/")],
      { zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z" },
    );
    const text = renderReportText(report);
    expect(text).toContain("Coverage: 1/7 days");
    expect(text).toContain("sequential_traversal_score: omitted");
    expect(text).not.toContain("<script>");
  });
});

describe("renderReportHtml (adversarial: traffic-field injection)", () => {
  const INJECTION_UA = `<img src=x onerror="alert('xss')">bot`;
  const INJECTION_PATH = `/<script>alert(1)</script>profile?id="&'`;

  it("HTML-escapes a malicious user agent and path", () => {
    const report = buildWeeklyReport(
      [adversarialRollup("2026-08-13", INJECTION_UA, INJECTION_PATH)],
      { zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z" },
    );
    const html = renderReportHtml(report);

    // The raw injection markup must not appear verbatim.
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    // Escaped forms must be present.
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Quotes escaped for attribute safety.
    expect(html).toContain("&quot;");
  });

  it("truncates overly long traffic strings before rendering", () => {
    const longPath = "/" + "a".repeat(2000);
    const report = buildWeeklyReport(
      [adversarialRollup("2026-08-13", "ua", longPath)],
      { zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z" },
    );
    const html = renderReportHtml(report);
    // The full 2000-char path must not be present.
    expect(html).not.toContain("a".repeat(2000));
    expect(html.length).toBeLessThan(10000);
  });

  it("renders a complete HTML document with a title and id", () => {
    const report = buildWeeklyReport(
      [adversarialRollup("2026-08-13", "Googlebot", "/")],
      { zoneId: ZONE_ID, hostname: HOSTNAME, startDay: "2026-08-07", endDay: "2026-08-13", generatedAt: "2026-08-13T05:00:00Z" },
    );
    const html = renderReportHtml(report);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("Bot Traffic Weekly Report");
    expect(html).toContain(`report-${ZONE_ID}`);
  });
});