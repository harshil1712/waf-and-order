import { describe, expect, it } from "vitest";

import { isCalendarDay, recordMonitoringEndDay } from "../src/shared/monitor-endday.ts";
import type { ZoneAgentState } from "../src/shared/types.ts";

function state(overrides: Partial<ZoneAgentState> = {}): ZoneAgentState {
  return {
    schemaVersion: 2,
    zoneId: "zone-abc",
    recommendations: [],
    approvalTokens: [],
    approvedRecords: [],
    allowedEnvelopeSenders: [],
    appliedRules: [],
    recentOutcomes: [],
    reportPreferences: { timezone: "UTC", includeHtml: true, includeText: true },
    ...overrides,
  };
}

describe("isCalendarDay", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isCalendarDay("2026-08-18")).toBe(true);
    expect(isCalendarDay("2026-08-01")).toBe(true);
  });

  it("rejects non-strings and malformed strings", () => {
    expect(isCalendarDay(undefined)).toBe(false);
    expect(isCalendarDay(123)).toBe(false);
    expect(isCalendarDay(null)).toBe(false);
    expect(isCalendarDay("")).toBe(false);
    expect(isCalendarDay("2026-8-18")).toBe(false);
    expect(isCalendarDay("2026/08/18")).toBe(false);
    expect(isCalendarDay("2026-08-18T00:00:00Z")).toBe(false);
  });

  it("rejects impossible calendar dates via UTC round-trip", () => {
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("2026-00-10")).toBe(false);
  });
});

describe("recordMonitoringEndDay (monotonic durable persistence)", () => {
  it("persists a valid endDay when none is set yet", () => {
    const next = recordMonitoringEndDay(state(), "2026-08-18");
    expect(next.lastMonitoringEndDay).toBe("2026-08-18");
  });

  it("moves forward to a newer endDay", () => {
    const s = state({ lastMonitoringEndDay: "2026-08-18" });
    const next = recordMonitoringEndDay(s, "2026-08-19");
    expect(next.lastMonitoringEndDay).toBe("2026-08-19");
  });

  it("does NOT move backward on an older or equal (replayed) signal", () => {
    const s = state({ lastMonitoringEndDay: "2026-08-18" });
    expect(recordMonitoringEndDay(s, "2026-08-18").lastMonitoringEndDay).toBe("2026-08-18");
    expect(recordMonitoringEndDay(s, "2026-08-17").lastMonitoringEndDay).toBe("2026-08-18");
  });

  it("ignores an invalid candidate, returning the same state object", () => {
    const s = state({ lastMonitoringEndDay: "2026-08-18" });
    expect(recordMonitoringEndDay(s, "not-a-date")).toBe(s);
    expect(recordMonitoringEndDay(s, "2026-02-31")).toBe(s);
  });

  it("is replay-safe: returns the same object when the candidate is not newer", () => {
    const s = state({ lastMonitoringEndDay: "2026-08-18" });
    expect(recordMonitoringEndDay(s, "2026-08-18")).toBe(s);
    expect(recordMonitoringEndDay(s, "2026-08-10")).toBe(s);
  });

  it("never mutates the input state object", () => {
    const s = state({ lastMonitoringEndDay: "2026-08-18" });
    const next = recordMonitoringEndDay(s, "2026-08-19");
    expect(s.lastMonitoringEndDay).toBe("2026-08-18");
    expect(next.lastMonitoringEndDay).toBe("2026-08-19");
    expect(next).not.toBe(s);
  });
});