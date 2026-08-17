import { CONFIRMED_DIMENSIONS, type ConfirmedDimension } from "./capability.ts";
import type { GroupingSetName } from "./types.ts";

/**
 * The GraphQL `dimensions { ... }` projection for each grouping set.
 *
 * Every field listed here is a capability-confirmed dimension (live probe:
 * `verifiedBotCategory` and `requestSource`, not `verifiedBot`/`clientRequestSource`).
 * The grouping sets are chosen to be non-overlapping combinations: each cell
 * belongs to exactly one grouping set, and the grouping-set name is stored
 * with every cell so queries never sum across overlapping rollups.
 */
const GROUPING_SET_PROJECTIONS: Record<GroupingSetName, readonly ConfirmedDimension[]> = {
  verified_bot_country: ["verifiedBotCategory", "clientCountryName"],
  ua_verified_bot: ["userAgent", "verifiedBotCategory"],
  path_status: ["clientRequestPath", "edgeResponseStatus"],
  source_country: ["requestSource", "clientCountryName"],
};

/** Every dimension field referenced by any grouping set is capability-confirmed. */
export function assertDimensionsConfirmed(): void {
  for (const projection of Object.values(GROUPING_SET_PROJECTIONS)) {
    for (const field of projection) {
      if (!CONFIRMED_DIMENSIONS.includes(field)) {
        throw new Error(`dimension not confirmed by capability matrix: ${field}`);
      }
    }
  }
}

/** Build the GraphQL `dimensions { ... }` block for a grouping set. */
export function dimensionsBlock(groupingSet: GroupingSetName): string {
  return GROUPING_SET_PROJECTIONS[groupingSet].join(" ");
}