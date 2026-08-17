/**
 * Runtime capability matrix.
 *
 * Maps each claimed metric to the dataset, dimensions, and aggregation it
 * depends on. Two metrics are deliberately omitted on this plan because the
 * source data cannot support them:
 *
 * - sequential traversal score — needs per-IP/per-session path sequences, not
 *   just marginal aggregates.
 * - distributed-IP correlation — needs multi-IP behavior grouping, not just
 *   independent distinct-IP counts.
 *
 * Security-event metrics (challenge count, challenge solve rate) are also
 * omitted because `firewallEventsAdaptiveGroups` is not available on this
 * plan. Client-ASN and Bot Management decision dimensions are omitted
 * because the traffic dataset does not expose them on this plan. A distinct-IP
 * estimate is omitted because the `uniq` aggregation is not available on this
 * plan.
 *
 * The matrix is checked at query time: metrics whose dependencies are not all
 * available are excluded from findings and reports rather than fabricated.
 */

/** Dimensions confirmed available by live probe for `httpRequestsAdaptiveGroups`. */
export const CONFIRMED_DIMENSIONS = [
  "clientCountryName",
  "clientRequestPath",
  "userAgent",
  "verifiedBotCategory",
  "cacheStatus",
  "edgeResponseStatus",
  "requestSource",
] as const;

export type ConfirmedDimension = (typeof CONFIRMED_DIMENSIONS)[number];

/** A metric claim: a named metric backed by a concrete set of supported dependencies. */
export interface CapabilityClaim {
  metric: string;
  supported: boolean;
  dataset: string;
  dependsOn: readonly string[];
  /** Human explanation of why the metric is supported or omitted. */
  reason: string;
}

/**
 * The capability matrix. `supported: false` entries exist so reports
 * and tools can state explicitly that a metric was considered and omitted
 * rather than silently absent.
 */
export const CAPABILITY_MATRIX: readonly CapabilityClaim[] = [
  {
    metric: "request_count",
    supported: true,
    dataset: "httpRequestsAdaptiveGroups",
    dependsOn: ["count"],
    reason: "count aggregation is available on the plan.",
  },
  {
    metric: "bytes",
    supported: true,
    dataset: "httpRequestsAdaptiveGroups",
    dependsOn: ["sum.edgeResponseBytes"],
    reason: "sum of edge response bytes is available on the plan.",
  },
  {
    metric: "unique_ips_estimate",
    supported: false,
    dataset: "httpRequestsAdaptiveGroups",
    dependsOn: ["uniq.uniques"],
    reason: "the uniq aggregation is an unknown field on this plan (live probe); no distinct-IP estimate is available.",
  },
  {
    metric: "sequential_traversal_score",
    supported: false,
    dataset: "httpRequestsAdaptiveGroups",
    dependsOn: ["per-ip-or-session path sequence"],
    reason: "the dataset exposes only marginal aggregates, not per-IP/session request sequences.",
  },
  {
    metric: "distributed_ip_correlation",
    supported: false,
    dataset: "httpRequestsAdaptiveGroups",
    dependsOn: ["multi-ip behavior grouping"],
    reason: "the dataset does not expose the per-IP behavior grouping required.",
  },
  {
    metric: "challenge_solve_rate",
    supported: false,
    dataset: "firewallEventsAdaptiveGroups",
    dependsOn: ["firewall events"],
    reason: "firewallEventsAdaptiveGroups is not available on this plan.",
  },
];

/** Metrics considered supported by the runtime capability matrix. */
export function supportedMetrics(): string[] {
  return CAPABILITY_MATRIX.filter((claim) => claim.supported).map((claim) => claim.metric);
}