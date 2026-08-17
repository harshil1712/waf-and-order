import { describe, expect, it } from "vitest";

import { CAPABILITY_MATRIX, supportedMetrics } from "../src/analytics/capability.ts";
import { assertDimensionsConfirmed } from "../src/analytics/dimensions.ts";

describe("capability matrix", () => {
  it("confirms only the metrics the plan actually supports", () => {
    const supported = supportedMetrics();
    expect(supported).toContain("request_count");
    expect(supported).toContain("bytes");
    // unique_ips_estimate depends on the uniq aggregation, an unknown field on
    // this plan; it must NOT be claimed supported.
    expect(supported).not.toContain("unique_ips_estimate");
    expect(supported).not.toContain("sequential_traversal_score");
    expect(supported).not.toContain("distributed_ip_correlation");
    expect(supported).not.toContain("challenge_solve_rate");
  });

  it("every grouping-set dimension is capability-confirmed", () => {
    expect(() => assertDimensionsConfirmed()).not.toThrow();
  });

  it("has explicit omitted claims for unsupported metrics", () => {
    const omitted = CAPABILITY_MATRIX.filter((c) => !c.supported);
    expect(omitted.length).toBeGreaterThanOrEqual(3);
    for (const claim of omitted) {
      expect(claim.reason.length).toBeGreaterThan(0);
    }
  });
});