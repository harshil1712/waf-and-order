/**
 * Shared zone-resolution context for model-facing tools.
 *
 * A tool that operates across zones resolves its target zone from an optional
 * model-supplied `zoneId`, then loads that zone's config (from D1) and state
 * slice (from the shared control-plane state) via injected resolvers. The model
 * NEVER supplies a ruleset id, hostname, expression, action, or payload — those
 * are always resolved from trusted D1/state by the tool and cross-checked.
 *
 * The resolvers are optional so the single-zone tool factory signatures keep
 * working with a baked-in single zone (tests pass fixed deps). When the
 * resolvers are absent, a tool falls back to its mounted default zone/config.
 */

import type { R2Store } from "../analytics/storage.ts";
import type { ZoneConfig } from "../registry/zone-registry.ts";
import type { ZoneAgentState } from "../shared/types.ts";

/** The value-or-functional setter form used by persistent-state writes. */
export type ZoneSliceSetterValue =
  | ZoneAgentState
  | ((previous: ZoneAgentState) => ZoneAgentState);

/** Injected cross-zone resolution surface a tool may use. */
export interface ZoneContext {
  /** The zone this tool instance is mounted for (default when model omits zoneId). */
  zoneId: string;
  /** Resolve a zone's D1 config; null when unknown or disabled. */
  resolveZoneConfig: (zoneId: string) => Promise<ZoneConfig | null>;
  /** Resolve a zone's current state slice from the shared control-plane state. */
  resolveSlice: (zoneId: string) => ZoneAgentState;
  /** Write a zone's slice back to the shared control-plane state. */
  setSlice: (zoneId: string, value: ZoneSliceSetterValue) => void;
  /** Resolve the zone-keyed R2 bucket. */
  resolveBucket: (zoneId: string) => R2Store;
}

/** A minimal zone id validation error. */
class UnknownOrDisabledZoneError extends Error {
  constructor(zoneId: string) {
    super(`unknown or disabled zone: ${zoneId}`);
    this.name = "UnknownOrDisabledZoneError";
  }
}

/** Validate a model-supplied zone id against D1 config (fails closed). */
async function requireEnabledZone(
  ctx: Pick<ZoneContext, "resolveZoneConfig">,
  zoneId: string,
): Promise<ZoneConfig> {
  const config = await ctx.resolveZoneConfig(zoneId);
  if (!config) {
    throw new UnknownOrDisabledZoneError(zoneId);
  }
  return config;
}

/**
 * Resolve the target zone for a run: the model-supplied `zoneId` wins when
 * present (validated against D1), otherwise the mounted default is used. The
 * mounted default is also validated against D1 so a disabled/unknown mounted
 * zone fails closed.
 */
export async function resolveTargetZone(
  ctx: Pick<ZoneContext, "resolveZoneConfig">,
  requestedZoneId: string | undefined,
  defaultZoneId: string,
): Promise<{ zoneId: string; config?: ZoneConfig }> {
  const zoneId = requestedZoneId ?? defaultZoneId;
  const config = await requireEnabledZone(ctx, zoneId);
  return { zoneId, config };
}
