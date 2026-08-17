import { describe, expect, it } from "vitest";

import { ZoneRegistryRepository } from "../src/registry/d1.ts";
import { isRollbackConfirmation, ROLLBACK_CONFIRMATION_PHRASE } from "../src/registry/operator-actions.ts";
import { splitSenderList } from "../src/registry/zone-registry.ts";
import { FakeD1, zoneRowForTest } from "./helpers/fake-d1.ts";

describe("ZoneRegistryRepository (D1, prepared statements only)", () => {
  it("returns null for an unknown zone", async () => {
    const repo = new ZoneRegistryRepository(new FakeD1([zoneRowForTest("zone-a", "a.example.com")]));
    expect(await repo.getEnabledZone("zone-nope")).toBeNull();
  });

  it("listEnabledZones excludes disabled zones and sorts by hostname", async () => {
    const db = new FakeD1([
      { ...zoneRowForTest("zone-b", "b.example.com") },
      { ...zoneRowForTest("zone-a", "a.example.com") },
      { ...zoneRowForTest("zone-off", "off.example.com"), enabled: 0 },
    ]);
    const repo = new ZoneRegistryRepository(db);
    const zones = await repo.listEnabledZones();
    expect(zones.map((z) => z.zoneId)).toEqual(["zone-a", "zone-b"]);
  });

  it("records an operator action as an append-only audit row", async () => {
    const db = new FakeD1([zoneRowForTest("zone-a", "a.example.com")]);
    const repo = new ZoneRegistryRepository(db);
    const id = await repo.recordOperatorAction({
      zoneId: "zone-a",
      recommendationId: "R-1",
      action: "waf.rollback.authorized",
      operatorIdentity: "ops@x.com",
      confirmationPhrase: ROLLBACK_CONFIRMATION_PHRASE,
      createdAt: "2026-08-12T00:00:00Z",
    });
    expect(id).toBeGreaterThan(0);
    const id2 = await repo.recordOperatorAction({
      zoneId: "zone-a",
      recommendationId: "R-2",
      action: "waf.rollback.authorized",
      operatorIdentity: "ops2@x.com",
      confirmationPhrase: ROLLBACK_CONFIRMATION_PHRASE,
      createdAt: "2026-08-12T00:01:00Z",
    });
    expect(id2).toBeGreaterThan(id);
    const { results } = await db
      .prepare(
        "SELECT id, zone_id, recommendation_id, action, operator_identity, metadata FROM operator_actions WHERE zone_id = ? ORDER BY id DESC LIMIT ?",
      )
      .bind("zone-a", 10)
      .all<{
        id: number;
        zone_id: string;
        recommendation_id: string;
        action: string;
        operator_identity: string;
        metadata: string;
      }>();
    expect(results).toHaveLength(2);
    // Newest first.
    expect(results[0].recommendation_id).toBe("R-2");
    expect(results[1].recommendation_id).toBe("R-1");
    expect(results[0].id).toBe(id2);
    expect(JSON.parse(results[0].metadata || "{}")).toEqual({});
    // Another zone's rows are isolated.
    const other = await db
      .prepare("SELECT id FROM operator_actions WHERE zone_id = ? ORDER BY id DESC LIMIT ?")
      .bind("zone-b", 10)
      .all<{ id: number }>();
    expect(other.results).toEqual([]);
  });

  it("does not expose secrets in stored rows", async () => {
    const db = new FakeD1([zoneRowForTest("zone-a", "a.example.com")]);
    const repo = new ZoneRegistryRepository(db);
    await repo.recordOperatorAction({
      zoneId: "zone-a",
      recommendationId: "R-1",
      action: "waf.rollback.authorized",
      operatorIdentity: "ops@x.com",
      confirmationPhrase: ROLLBACK_CONFIRMATION_PHRASE,
      createdAt: "2026-08-12T00:00:00Z",
    });
    const { results } = await db
      .prepare("SELECT metadata FROM operator_actions WHERE zone_id = ? ORDER BY id DESC LIMIT ?")
      .bind("zone-a", 10)
      .all<{ metadata: string }>();
    expect(JSON.stringify(results)).not.toMatch(/token|secret|credential|WAF_WRITE/i);
  });
});

describe("confirmation phrase + sender helpers", () => {
  it("requires the exact rollback confirmation phrase", () => {
    expect(isRollbackConfirmation(ROLLBACK_CONFIRMATION_PHRASE)).toBe(true);
    expect(isRollbackConfirmation("yes")).toBe(false);
    expect(isRollbackConfirmation("")).toBe(false);
    expect(isRollbackConfirmation(`  ${ROLLBACK_CONFIRMATION_PHRASE}  `)).toBe(true);
  });

  it("splits and trims comma-separated senders", () => {
    expect(splitSenderList(" a@x.com ,  b@x.com  ")).toEqual(["a@x.com", "b@x.com"]);
    expect(splitSenderList("")).toEqual([]);
  });
});