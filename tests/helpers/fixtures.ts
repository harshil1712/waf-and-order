/**
 * Shared test fixtures: a canned GraphQL fetcher and a full daily rollup.
 */

import type { AdaptiveGroupsRow } from "../../src/analytics/graphql.ts";
import type { DayCellsFetcher } from "../../src/analytics/collector.ts";
import type { DailyRollup } from "../../src/analytics/types.ts";

/** Detect which grouping set a collector query targets from its projection. */
export function groupingSetInQuery(query: string): string {
  if (query.includes("verifiedBotCategory") && query.includes("clientCountryName")) return "verified_bot_country";
  if (query.includes("userAgent") && query.includes("verifiedBotCategory")) return "ua_verified_bot";
  if (query.includes("clientRequestPath") && query.includes("edgeResponseStatus")) return "path_status";
  if (query.includes("requestSource") && query.includes("clientCountryName")) return "source_country";
  return "unknown";
}

const COUNTRY_SAMPLE = ["US", "DE", "IN"];

/** Build canned adaptive-groups rows for a grouping set on a day. */
function rowsForGroupingSet(set: string): AdaptiveGroupsRow[] {
  switch (set) {
    case "verified_bot_country":
      return COUNTRY_SAMPLE.map((country, i) => ({
        count: 1000 - i * 200,
        sum: { edgeResponseBytes: (1000 - i * 200) * 400 },
        dimensions: { verifiedBotCategory: i === 0, clientCountryName: country },
      }));
    case "ua_verified_bot":
      return [
        {
          count: 800,
          sum: { edgeResponseBytes: 320000 },
          dimensions: { userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)", verifiedBotCategory: true },
        },
        {
          count: 600,
          sum: { edgeResponseBytes: 240000 },
          dimensions: { userAgent: "Mozilla/5.0 <script>alert(1)</script>", verifiedBotCategory: false },
        },
      ];
    case "path_status":
      return [
        {
          count: 300,
          sum: { edgeResponseBytes: 120000 },
          dimensions: { clientRequestPath: "/profile/12345", edgeResponseStatus: 200 },
        },
        {
          count: 40,
          sum: { edgeResponseBytes: 16000 },
          dimensions: { clientRequestPath: "/login", edgeResponseStatus: 404 },
        },
      ];
    case "source_country":
      return COUNTRY_SAMPLE.slice(0, 2).map((country, i) => ({
        count: 700 - i * 100,
        sum: { edgeResponseBytes: 280000 - i * 40000 },
        dimensions: { requestSource: i === 0 ? "eyeball" : "privacy_passer", clientCountryName: country },
      }));
    default:
      return [];
  }
}

/** A deterministic canned fetcher returning adaptive-groups rows per query. */
export function cannedFetcher(): DayCellsFetcher {
  return async (query) => ({
    data: {
      viewer: {
        zones: [
          {
            httpRequestsAdaptiveGroups: rowsForGroupingSet(groupingSetInQuery(query)),
          },
        ],
      },
    },
  });
}

/** The zone/hostname used in fixtures. */
export const ZONE_ID = "zone-abc";
export const HOSTNAME = "example.com";

/** A fully-formed daily rollup fixture (used to seed storage tests). */
export function makeRollup(day: string): DailyRollup {
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
        {
          groupingSet: "verified_bot_country",
          dimensions: { verifiedBotCategory: true, clientCountryName: "US" },
          requestCount: 1000,
          bytes: 400000,
        },
      ],
    },
    truncatedGroupingSets: [],
  };
  return { ...rollup, sha256: "computed-by-caller" };
}