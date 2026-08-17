/**
 * Typed D1 zone-registry repository.
 *
 * All queries use D1 prepared statements with `?` positional binds — never
 * string interpolation of untrusted values. The repository accepts a minimal
 * structural `D1DatabaseLike` interface so it is unit-testable with an
 * in-memory fake and binds cleanly to the real `D1Database` binding in
 * `CloudflareBindings`.
 *
 * SECURITY: only non-secret zone metadata is stored/read. Secrets are never
 * written to or read from D1.
 */

import type { NewOperatorAction } from "./operator-actions.ts";
import {
  splitSenderList,
  type ZoneConfig,
} from "./zone-registry.ts";

/** Minimal prepared-statement surface used by the repository. */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { last_row_id?: number; changes?: number } }>;
}

/** Minimal D1 database surface (satisfied by the real D1Database binding). */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
}

/** A zone row as stored in D1 (snake_case columns). */
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

/** Map a stored row to a {@link ZoneConfig}. */
function rowToZone(row: ZoneRow): ZoneConfig {
  return {
    zoneId: row.zone_id,
    hostname: row.hostname,
    rulesetId: row.ruleset_id,
    rulesetPhase: row.ruleset_phase,
    rulesetVersion: row.ruleset_version,
    enabled: row.enabled === 1,
    allowedEnvelopeSenders: splitSenderList(row.allowed_envelope_senders),
    reportSender: row.report_sender,
    reportRecipient: row.report_recipient,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The zone-registry repository. Constructed once from a D1 binding and reused.
 * Every method is async and uses prepared statements.
 */
export class ZoneRegistryRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  /** Load one enabled zone by id, or null when absent or disabled. */
  async getEnabledZone(zoneId: string): Promise<ZoneConfig | null> {
    const row = await this.db
      .prepare(
        "SELECT zone_id, hostname, ruleset_id, ruleset_phase, ruleset_version, " +
          "enabled, allowed_envelope_senders, report_sender, report_recipient, " +
          "created_at, updated_at FROM zones WHERE zone_id = ? AND enabled = 1",
      )
      .bind(zoneId)
      .first<ZoneRow>();
    return row ? rowToZone(row) : null;
  }

  /** List only enabled zones, deterministic by hostname. */
  async listEnabledZones(): Promise<ZoneConfig[]> {
    const { results } = await this.db
      .prepare(
        "SELECT zone_id, hostname, ruleset_id, ruleset_phase, ruleset_version, " +
          "enabled, allowed_envelope_senders, report_sender, report_recipient, " +
          "created_at, updated_at FROM zones WHERE enabled = 1 ORDER BY hostname ASC",
      )
      .all<ZoneRow>();
    return results.map(rowToZone);
  }

  /**
   * Append an operator action to the audit log. Returns the new row id.
   * Written BEFORE any rollback dispatch so every authorized action is audited.
   */
  async recordOperatorAction(action: NewOperatorAction): Promise<number> {
    const result = await this.db
      .prepare(
        "INSERT INTO operator_actions " +
          "(zone_id, recommendation_id, action, operator_identity, " +
          "confirmation_phrase, metadata, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        action.zoneId,
        action.recommendationId,
        action.action,
        action.operatorIdentity,
        action.confirmationPhrase,
        JSON.stringify(action.metadata ?? {}),
        action.createdAt,
      )
      .run();
    return result.meta?.last_row_id ?? 0;
  }
}