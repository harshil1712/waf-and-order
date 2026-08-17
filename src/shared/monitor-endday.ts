/**
 * Pure reducer for persisting the latest completed monitoring endDay.
 *
 * The monitoring signal carries the latest completed UTC day. We persist it to
 * durable state (`ZoneAgentState.lastMonitoringEndDay`) so checkpoint due-ness
 * survives intervening tool calls/renders and durable replay, instead of living
 * in a render-local ref.
 *
 * The update is validated and MONOTONIC:
 *   - the candidate must be a valid YYYY-MM-DD, otherwise it is ignored;
 *   - a candidate older than or equal to the current persisted value never moves
 *     the value backward (older/replayed signals converge to the newest day).
 *
 * No WAF/email side effects here — a pure, unit-testable reducer.
 */

import type { ZoneAgentState } from "./types.ts";

/** Whether a string is a valid YYYY-MM-DD calendar day. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Reject impossible dates (e.g. 2026-02-31) by round-tripping through UTC.
  const asDate = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(asDate.getTime()) && asDate.toISOString().slice(0, 10) === value;
}

/**
 * Persist a monitoring endDay into state monotonically. Returns the next state.
 * An invalid candidate or one not newer than the persisted value returns the
 * same state object unchanged (safe for replay).
 */
export function recordMonitoringEndDay(
  state: ZoneAgentState,
  endDay: unknown,
): ZoneAgentState {
  if (!isCalendarDay(endDay)) {
    return state;
  }
  const current = state.lastMonitoringEndDay;
  if (current !== undefined && endDay <= current) {
    return state; // monotonic: never move backward on older/replayed signals
  }
  return { ...state, lastMonitoringEndDay: endDay };
}