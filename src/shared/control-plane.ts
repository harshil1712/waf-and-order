/**
 * Shared control-plane persistent state (schemaVersion 3).
 *
 * One Flue agent instance (`control-plane`) owns ONE durable state object that
 * holds a per-zone slice of the prior {@link ZoneAgentState} for every zone in
 * the registry. The MVP accepts NO per-zone isolation: every Access-admitted
 * operator can manage every zone, and all zones share one conversation.
 *
 * Design rules that keep this deterministic despite shared state:
 *
 *   - Every recommendation, approval token, applied rule, monitoring record,
 *     and rollback outcome ALREADY carries `zoneId` (see the immutable
 *     Recommendation model). A slice is the same shape as the legacy per-zone
 *     {@link ZoneAgentState}, so all existing pure reducers operate unchanged on
 *     a slice.
 *   - IDs may collide across zones (recommendation ids, token ids), so lookups
 *     must ALWAYS be zone-scoped — never search globally without `zoneId`.
 *   - Writes update ONLY the selected zone slice via {@link updateZoneSlice};
 *     a read-modify-write of any other slice is a bug.
 *
 * Backward safety: the old `zone:<id>` Durable Object state (schemaVersion 2,
 * one DO per zone) is NOT auto-migrated and is left untouched. This module only
 * normalizes the NEW shared `control-plane` state; it never claims to
 * reconstruct live applied state from the legacy DO state (a recommendation's
 * exact applied mutation payload is authoritative only in its own state slice,
 * and the old DO state is not read).
 */

import type { ZoneAgentState } from "./types.ts";

/** The single shared Flue conversation id for the control-plane agent. */
export const CONTROL_PLANE_CONVERSATION_ID = "control-plane";

/**
 * Shared control-plane state: a map from zoneId to that zone's agent state
 * slice (the legacy per-zone {@link ZoneAgentState} shape).
 */
export interface ControlPlaneState {
  schemaVersion: 3;
  zones: Record<string, ZoneAgentState>;
}

/** A per-zone slice of control-plane state (same shape as ZoneAgentState). */
export type ZoneSlice = ZoneAgentState;

/** Build an empty zone slice (schemaVersion 2, matching the legacy per-zone defaults). */
export function defaultZoneSlice(zoneId: string): ZoneSlice {
  return {
    schemaVersion: 2,
    zoneId,
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: {
      timezone: "UTC",
      includeHtml: true,
      includeText: true,
    },
  };
}

/** Build a new, empty control-plane state (schemaVersion 3). */
export function emptyControlPlaneState(): ControlPlaneState {
  return { schemaVersion: 3, zones: {} };
}

/** Deep-normalize one zone slice against {@link defaultZoneSlice}. */
export function normalizeZoneSlice(zoneId: string, raw: unknown): ZoneSlice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultZoneSlice(zoneId);
  }
  const r = raw as Partial<ZoneAgentState>;
  const base = defaultZoneSlice(zoneId);
  return {
    ...base,
    // Force the map key as the authoritative zoneId.
    ...r,
    zoneId,
    // Force/guarantee array fields so reducers never throw on a missing array.
    recommendations: Array.isArray(r.recommendations) ? r.recommendations : base.recommendations,
    approvalTokens: Array.isArray(r.approvalTokens) ? r.approvalTokens : base.approvalTokens,
    approvedRecords: Array.isArray(r.approvedRecords) ? r.approvedRecords : base.approvedRecords,
    allowedEnvelopeSenders: Array.isArray(r.allowedEnvelopeSenders)
      ? r.allowedEnvelopeSenders
      : base.allowedEnvelopeSenders,
    appliedRules: Array.isArray(r.appliedRules) ? r.appliedRules : base.appliedRules,
    recentOutcomes: Array.isArray(r.recentOutcomes) ? r.recentOutcomes : base.recentOutcomes,
    monitoringRecords: Array.isArray(r.monitoringRecords) ? r.monitoringRecords : [],
    rollbackOutcomes: Array.isArray(r.rollbackOutcomes) ? r.rollbackOutcomes : [],
    reportPreferences:
      r.reportPreferences && typeof r.reportPreferences === "object"
        ? { ...base.reportPreferences, ...r.reportPreferences }
        : base.reportPreferences,
  };
}

/**
 * Backward-safe normalization: accept an unknown persisted value and return a
 * valid {@link ControlPlaneState}. If the value is not a schemaVersion-3
 * control-plane state (missing/foreign schema, legacy zone: state), a fresh
 * empty state is returned. Every zone slice is deep-normalized via
 * {@link normalizeZoneSlice} so malformed/non-object slices are dropped (reset
 * to an empty slice keyed by the map key) and missing arrays are defaulted.
 * It NEVER attempts to migrate legacy `zone:<id>` DO state — that remains
 * untouched.
 */
export function normalizeControlPlaneState(
  value: unknown,
): ControlPlaneState {
  if (
    !value ||
    typeof value !== "object" ||
    (value as ControlPlaneState).schemaVersion !== 3 ||
    !(value as ControlPlaneState).zones ||
    typeof (value as ControlPlaneState).zones !== "object"
  ) {
    return emptyControlPlaneState();
  }
  const zones = (value as ControlPlaneState).zones as Record<string, unknown>;
  const normalized: Record<string, ZoneAgentState> = {};
  for (const [key, slice] of Object.entries(zones)) {
    normalized[key] = normalizeZoneSlice(key, slice);
  }
  return { schemaVersion: 3, zones: normalized };
}

/** Read the slice for a zone, creating (and returning) an empty one if absent. */
export function getZoneSlice(
  state: ControlPlaneState,
  zoneId: string,
): ZoneSlice {
  return state.zones[zoneId] ?? defaultZoneSlice(zoneId);
}

/**
 * Update ONLY the selected zone slice with a functional reducer. `update` is
 * given the current (deep-normalized) slice or a fresh default and returns the
 * next slice. All other slices are preserved by reference. Returns the next
 * state. The current slice is normalized first so a malformed or array-missing
 * stored slice cannot throw inside the reducer.
 */
export function updateZoneSlice(
  state: ControlPlaneState,
  zoneId: string,
  update: (slice: ZoneSlice) => ZoneSlice,
): ControlPlaneState {
  const current = state.zones[zoneId] ?? defaultZoneSlice(zoneId);
  const safeCurrent = normalizeZoneSlice(zoneId, current);
  const next = update(safeCurrent);
  if (next === current) return state;
  return { ...state, zones: { ...state.zones, [zoneId]: next } };
}