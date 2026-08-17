import { describe, expect, it } from "vitest";

import {
  runDailyCron,
  runDispatchCron,
} from "../src/cloudflare/cron-signals.ts";
import { ZoneRegistryRepository } from "../src/registry/d1.ts";
import { FakeD1, zoneRowForTest } from "./helpers/fake-d1.ts";

function seededDb() {
  return new FakeD1([
    zoneRowForTest("zone-a", "a.example.com"),
    zoneRowForTest("zone-b", "b.example.com"),
    { ...zoneRowForTest("zone-off", "off.example.com"), enabled: 0 },
  ]);
}

describe("cron per-zone failure isolation", () => {
  it("runDispatchCron isolates a failing zone and still dispatches later zones", async () => {
    const registry = new ZoneRegistryRepository(seededDb());
    const dispatched: string[] = [];
    const results = await runDispatchCron(registry, async (zone) => {
      if (zone.zoneId === "zone-a") throw new Error("dispatch exploded");
      dispatched.push(zone.zoneId);
    });
    // zone-a failed; zone-b still dispatched; disabled zone skipped.
    expect(dispatched).toEqual(["zone-b"]);
    expect(results).toEqual([
      { zoneId: "zone-a", ok: false, error: "dispatch exploded" },
      { zoneId: "zone-b", ok: true },
    ]);
  });

  it("runDailyCron isolates a collecting failure and still collects/dispatches later zones", async () => {
    const registry = new ZoneRegistryRepository(seededDb());
    const collected: string[] = [];
    const dispatched: string[] = [];
    const results = await runDailyCron(
      registry,
      async (zone) => {
        if (zone.zoneId === "zone-a") throw new Error("graphql failed");
        collected.push(zone.zoneId);
        return { day: "2026-08-11", backfilledDays: [] };
      },
      async (zone) => {
        dispatched.push(zone.zoneId);
      },
    );
    expect(collected).toEqual(["zone-b"]);
    expect(dispatched).toEqual(["zone-b"]);
    expect(results).toEqual([
      { zoneId: "zone-a", ok: false, error: "graphql failed" },
      { zoneId: "zone-b", ok: true },
    ]);
  });

  it("runDailyCron isolates a dispatch failure after a successful collect", async () => {
    const registry = new ZoneRegistryRepository(seededDb());
    const results = await runDailyCron(
      registry,
      async (zone) => ({ day: "2026-08-11", backfilledDays: [] }),
      async (zone) => {
        if (zone.zoneId === "zone-a") throw new Error("dispatch failed");
      },
    );
    expect(results.map((r) => [r.zoneId, r.ok])).toEqual([
      ["zone-a", false],
      ["zone-b", true],
    ]);
  });
});
