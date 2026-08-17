-- Shared control-plane zone registry and operator audit log.
--
-- These tables are the authoritative multi-zone configuration source. They hold
-- NON-SECRET zone metadata only. Secrets (approval-token signing key, WAF write
-- token, analytics token, Access credentials) are NEVER stored in D1 — they
-- remain Worker secrets in `process.env`.
--
-- `zones` is the registry that cron dispatch, inbound email authorization, and
-- every tool/config resolver read from. `operator_actions` is an append-only
-- audit log written before any authorized operator rollback dispatch.

CREATE TABLE IF NOT EXISTS zones (
  zone_id                  TEXT PRIMARY KEY,
  hostname                 TEXT NOT NULL,
  ruleset_id               TEXT NOT NULL,
  ruleset_phase            TEXT NOT NULL DEFAULT 'http_request_firewall_custom',
  ruleset_version          TEXT NOT NULL DEFAULT '1',
  enabled                  INTEGER NOT NULL DEFAULT 1,
  allowed_envelope_senders TEXT NOT NULL DEFAULT '',
  report_sender            TEXT NOT NULL DEFAULT '',
  report_recipient         TEXT NOT NULL DEFAULT '',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_actions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id              TEXT NOT NULL,
  recommendation_id    TEXT NOT NULL,
  action               TEXT NOT NULL,
  operator_identity    TEXT NOT NULL,
  confirmation_phrase  TEXT NOT NULL,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_actions_zone
  ON operator_actions (zone_id, recommendation_id);