/**
 * Zone registry config types (non-secret, D1-backed).
 *
 * This is the authoritative multi-zone configuration model the shared
 * control-plane agent reads. Secrets are never part of these types — they live
 * in Worker secrets (`process.env`). `allowed_envelope_senders` and
 * `report_sender`/`report_recipient` are stored as delimited strings and
 * normalized into arrays on load.
 */

/** A single zone's non-secret configuration row. */
export interface ZoneConfig {
  /** Cloudflare zone id (also the R2 key scope and state slice key). */
  zoneId: string;
  /** The zone's primary hostname (used in report subjects and display). */
  hostname: string;
  /** The zone custom ruleset id the apply/rollback tools target. */
  rulesetId: string;
  /** The ruleset phase (custom ruleset phase). */
  rulesetPhase: string;
  /** The observed ruleset version (context only, not part of payload hash). */
  rulesetVersion: string;
  /** Whether the zone is enabled for collection/dispatch/monitoring. */
  enabled: boolean;
  /** Normalized list of SMTP envelope senders allowed to approve. */
  allowedEnvelopeSenders: string[];
  /** Cloudflare Email Sending verified sender, or "". */
  reportSender: string;
  /** Cloudflare Email Sending recipient, or "". */
  reportRecipient: string;
  /** ISO creation timestamp. */
  createdAt: string;
  /** ISO last-update timestamp. */
  updatedAt: string;
}

/** Split a stored comma-separated sender list into a trimmed, filtered array. */
export function splitSenderList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
