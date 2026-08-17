/**
 * In-memory fake D1 for the zone-registry repository tests.
 *
 * Evaluates the exact prepared-statement shapes the repository emits (zones
 * SELECTs and operator_actions INSERT/SELECT). Not a general SQL engine — it
 * matches the specific, parameterized statements the repository uses so tests
 * stay deterministic and typed against the real {@link D1DatabaseLike} surface.
 */

import type {
  D1DatabaseLike,
  D1PreparedStatement,
} from "../../src/registry/d1.ts";

interface ZoneRow {
  zone_id: string;
  hostname: string;
  ruleset_id: string;
  ruleset_phase: string;
  ruleset_version: string;
  enabled: number;
  allowed_envelope_senders: string;
  report_sender: string;
  report_recipient: string;
  created_at: string;
  updated_at: string;
}

interface OperatorRow {
  id: number;
  zone_id: string;
  recommendation_id: string;
  action: string;
  operator_identity: string;
  confirmation_phrase: string;
  metadata: string;
  created_at: string;
}

/** Seed a zone row from the same shape the migration inserts. */
function zoneRow(overrides: Partial<ZoneRow> = {}): ZoneRow {
  return {
    zone_id: "zone-a",
    hostname: "a.example.com",
    ruleset_id: "ruleset-a",
    ruleset_phase: "http_request_firewall_custom",
    ruleset_version: "1",
    enabled: 1,
    allowed_envelope_senders: "",
    report_sender: "",
    report_recipient: "",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A real-typed seed row (used to construct the fake table directly). */
export function zoneRowForTest(zoneId: string, hostname: string): ZoneRow {
  return zoneRow({ zone_id: zoneId, hostname });
}

export class FakeD1 implements D1DatabaseLike {
  private zones: ZoneRow[];
  private operatorActions: OperatorRow[] = [];
  private nextOperatorId = 1;

  constructor(seedZones: ZoneRow[] = []) {
    this.zones = seedZones.map((z) => ({ ...z }));
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(query, this);
  }

  private selectZones(whereEnabledOnly: boolean, zoneId?: string): ZoneRow[] {
    let rows = this.zones;
    if (zoneId) rows = rows.filter((z) => z.zone_id === zoneId);
    if (whereEnabledOnly) rows = rows.filter((z) => z.enabled === 1);
    return rows.sort((a, b) => a.hostname.localeCompare(b.hostname));
  }

  private insertOperatorAction(
    values: unknown[],
  ): { meta: { last_row_id: number; changes: number } } {
    const [zone_id, recommendation_id, action, operator_identity, confirmation_phrase, metadata, created_at] =
      values as string[];
    this.operatorActions.push({
      id: this.nextOperatorId,
      zone_id,
      recommendation_id,
      action,
      operator_identity,
      confirmation_phrase,
      metadata,
      created_at,
    });
    const id = this.nextOperatorId++;
    return { meta: { last_row_id: id, changes: 1 } };
  }

  private selectOperatorActions(
    zoneId: string,
    limit: number,
  ): { results: OperatorRow[] } {
    const rows = this.operatorActions
      .filter((r) => r.zone_id === zoneId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return { results: rows };
  }
}

class FakeStatement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly query: string,
    private readonly db: FakeD1,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const q = this.query;
    if (/FROM zones WHERE zone_id = \? AND enabled = 1/.test(q)) {
      const [zoneId] = this.values as string[];
      const rows = this.db["selectZones"](true, zoneId);
      return (rows[0] ?? null) as T | null;
    }
    if (/FROM zones WHERE zone_id = \?/.test(q)) {
      const [zoneId] = this.values as string[];
      const rows = this.db["selectZones"](false, zoneId);
      return (rows[0] ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const q = this.query;
    if (/FROM zones WHERE enabled = 1 ORDER BY hostname ASC/.test(q)) {
      return { results: this.db["selectZones"](true) as T[] };
    }
    if (/FROM zones ORDER BY hostname ASC/.test(q)) {
      return { results: this.db["selectZones"](false) as T[] };
    }
    if (/FROM operator_actions WHERE zone_id = \? ORDER BY id DESC LIMIT \?/.test(q)) {
      const [zoneId, limit] = this.values as [string, number];
      return this.db["selectOperatorActions"](zoneId, limit) as { results: T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta?: { last_row_id?: number; changes?: number } }> {
    if (/INSERT INTO operator_actions/.test(this.query)) {
      return this.db["insertOperatorAction"](this.values);
    }
    return { meta: { changes: 0 } };
  }
}
