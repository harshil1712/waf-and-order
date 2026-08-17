import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_CONVERSATION_ID,
  defaultZoneSlice,
  emptyControlPlaneState,
  getZoneSlice,
  normalizeControlPlaneState,
  normalizeZoneSlice,
  updateZoneSlice,
} from "../src/shared/control-plane.ts";
import { applyApprovalTransition } from "../src/shared/approval-state.ts";
import type { ApprovalTokenRecord, ZoneAgentState } from "../src/shared/types.ts";

describe("ControlPlaneState (schemaVersion 3, shared control plane)", () => {
  it("is version 3 with an empty zones map", () => {
    const state = emptyControlPlaneState();
    expect(state.schemaVersion).toBe(3);
    expect(state.zones).toEqual({});
  });

  it("normalizes foreign/legacy state back to empty (backward-safe)", () => {
    // Legacy schemaVersion-2 zone state is NOT auto-migrated.
    expect(normalizeControlPlaneState({ schemaVersion: 2, zoneId: "z" })).toEqual(
      emptyControlPlaneState(),
    );
    expect(normalizeControlPlaneState(null)).toEqual(emptyControlPlaneState());
    expect(normalizeControlPlaneState("garbage")).toEqual(emptyControlPlaneState());
    // A valid v3 state passes through (deep-normalized to a valid shape).
    const ok = { schemaVersion: 3, zones: { z: defaultZoneSlice("z") } };
    const normalized = normalizeControlPlaneState(ok);
    expect(normalized.schemaVersion).toBe(3);
    expect(normalized.zones.z.zoneId).toBe("z");
    expect(normalized.zones.z.recommendations).toEqual([]);
    // Deep normalization also guarantees the optional arrays.
    expect(normalized.zones.z.monitoringRecords).toEqual([]);
  });

  it("updateZoneSlice updates ONLY the selected zone slice", () => {
    const a = defaultZoneSlice("zone-a");
    const b = defaultZoneSlice("zone-b");
    const state = { schemaVersion: 3 as const, zones: { "zone-a": a, "zone-b": b } };

    const next = updateZoneSlice(state, "zone-a", (slice) => ({
      ...slice,
      recommendations: [{ id: "R-1" } as never],
    }));

    // zone-a changed, zone-b preserved by reference.
    expect(next.zones["zone-a"]).not.toBe(a);
    expect(next.zones["zone-a"].recommendations).toHaveLength(1);
    expect(next.zones["zone-b"]).toBe(b);
    expect(next.zones["zone-b"].recommendations).toHaveLength(0);
  });

  it("updateZoneSlice seeds a missing slice", () => {
    const state = emptyControlPlaneState();
    const next = updateZoneSlice(state, "zone-new", (slice) => ({
      ...slice,
      zoneId: slice.zoneId,
    }));
    expect(next.zones["zone-new"].zoneId).toBe("zone-new");
    expect(Object.keys(next.zones)).toEqual(["zone-new"]);
  });

  it("getZoneSlice returns a default for a missing zone without mutating", () => {
    const state = emptyControlPlaneState();
    const slice = getZoneSlice(state, "zone-missing");
    expect(slice.zoneId).toBe("zone-missing");
    // The state was not mutated.
    expect(state.zones).toEqual({});
  });

  it("a zone-scoped reducer only mutates its zone slice (idempotent approval)", () => {
    const state = {
      schemaVersion: 3 as const,
      zones: { "zone-a": defaultZoneSlice("zone-a"), "zone-b": defaultZoneSlice("zone-b") },
    };
    const bSlice = state.zones["zone-b"];

    // Issue a token + recommendation into zone-a's slice.
    const token: ApprovalTokenRecord = {
      tokenId: "tok-1",
      recommendationId: "R-1",
      zoneId: "zone-a",
      decision: "APPLY",
      createdAt: "2026-08-01T00:00:00Z",
      expiresAt: "2026-09-01T00:00:00Z",
      payload: JSON.stringify({ recommendationId: "R-1", zoneId: "zone-a" }),
      signedToken: "x",
    };
    const withRec = updateZoneSlice(state, "zone-a", (slice) => ({
      ...slice,
      recommendations: [
        {
          id: "R-1",
          zoneId: "zone-a",
          status: "pending_approval",
          expiresAt: "2026-09-01T00:00:00Z",
        } as never,
      ],
      approvalTokens: [token],
    }));

    const approved = updateZoneSlice(withRec, "zone-a", (slice) => {
      const outcome = applyApprovalTransition(slice, {
        recommendationId: "R-1",
        approvalTokenId: "tok-1",
        now: new Date("2026-08-15T00:00:00Z"),
      });
      return outcome.next ?? slice;
    });

    // zone-a transitioned; zone-b untouched.
    const recA = approved.zones["zone-a"].recommendations[0];
    expect((recA as { status: string }).status).toBe("approved");
    expect(approved.zones["zone-a"].approvalTokens[0].consumedAt).toBeDefined();
    expect(approved.zones["zone-b"]).toBe(bSlice);
  });

  it("uses the single shared conversation id", () => {
    expect(CONTROL_PLANE_CONVERSATION_ID).toBe("control-plane");
  });
});

describe("ControlPlaneState deep normalization", () => {
  it("drops a malformed non-object slice back to an empty default", () => {
    expect(normalizeZoneSlice("z", null)).toEqual(defaultZoneSlice("z"));
    expect(normalizeZoneSlice("z", "garbage")).toEqual(defaultZoneSlice("z"));
    expect(normalizeZoneSlice("z", 42)).toEqual(defaultZoneSlice("z"));
    expect(normalizeZoneSlice("z", [])).toEqual(defaultZoneSlice("z"));
  });

  it("forces the map key as the authoritative zoneId", () => {
    const normalized = normalizeZoneSlice("zone-a", { zoneId: "zone-mismatch" });
    expect(normalized.zoneId).toBe("zone-a");
  });

  it("defaults missing array fields so reducers never throw", () => {
    const normalized = normalizeZoneSlice("zone-a", { schemaVersion: 2 });
    expect(normalized.recommendations).toEqual([]);
    expect(normalized.approvalTokens).toEqual([]);
    expect(normalized.approvedRecords).toEqual([]);
    expect(normalized.allowedEnvelopeSenders).toEqual([]);
    expect(normalized.appliedRules).toEqual([]);
    expect(normalized.recentOutcomes).toEqual([]);
    expect(normalized.monitoringRecords).toEqual([]);
    expect(normalized.rollbackOutcomes).toEqual([]);
    expect(normalized.reportPreferences).toEqual({ timezone: "UTC", includeHtml: true, includeText: true });
  });

  it("rejects non-array field values (falls back to default arrays)", () => {
    const normalized = normalizeZoneSlice("zone-a", { recommendations: "not-an-array", appliedRules: 123 });
    expect(normalized.recommendations).toEqual([]);
    expect(normalized.appliedRules).toEqual([]);
  });

  it("preserves valid array data and normalizes reportPreferences", () => {
    const normalized = normalizeZoneSlice("zone-a", {
      recommendations: [{ id: "R-1" }],
      reportPreferences: { timezone: "America/New_York" },
    });
    expect(normalized.recommendations).toHaveLength(1);
    expect(normalized.reportPreferences.timezone).toBe("America/New_York");
    expect(normalized.reportPreferences.includeHtml).toBe(true); // default preserved
  });

  it("normalizeControlPlaneState deep-normalizes every zone slice", () => {
    const raw = {
      schemaVersion: 3,
      zones: {
        "zone-a": { schemaVersion: 2 }, // missing arrays
        "zone-b": "malformed",
      },
    };
    const state = normalizeControlPlaneState(raw);
    expect(state.zones["zone-a"].recommendations).toEqual([]);
    expect(state.zones["zone-a"].zoneId).toBe("zone-a");
    // Malformed slice reset to an empty default keyed by the map key.
    expect(state.zones["zone-b"]).toEqual(defaultZoneSlice("zone-b"));
  });

  it("updateZoneSlice normalizes a malformed stored slice before the reducer runs", () => {
    const state = {
      schemaVersion: 3,
      zones: { "zone-a": { schemaVersion: 2 } },
    } as unknown as {
      schemaVersion: 3;
      zones: Record<string, ZoneAgentState>;
    };
    // A reducer that reads appliedRules would throw if not normalized.
    const next = updateZoneSlice(state, "zone-a", (slice) => ({
      ...slice,
      appliedRules: [...(slice.appliedRules ?? [])],
    }));
    expect(next.zones["zone-a"].appliedRules).toEqual([]);
  });
});
