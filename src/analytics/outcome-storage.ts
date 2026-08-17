/**
 * Idempotent persistence of monitoring checkpoint outcomes to R2.
 *
 * Each checkpoint outcome is written under a deterministic key in an
 * `outcomes/` prefix and carries a SHA-256 integrity hash over its canonical
 * content. Writes are idempotent plain overwrites, so a retried or duplicated
 * checkpoint converges on one object (never appends).
 *
 * The outcome object is the durable, auditable record of what a monitoring
 * checkpoint computed. It is separate from the (possibly truncated) report
 * body and from the zone agent's compact in-memory state.
 */

import { canonicalJson, sha256 } from "../shared/canonical.ts";
import type { R2Store } from "./storage.ts";
import type { MonitoringCheckpoint, MonitoringReport } from "./monitor.ts";

/** Object-key prefix for checkpoint outcomes. */
const OUTCOME_PREFIX = "outcomes/";

/** Deterministic R2 key for one zone's one recommendation's checkpoint. */
export function outcomeKey(
  zoneId: string,
  recommendationId: string,
  checkpoint: MonitoringCheckpoint,
): string {
  return `${OUTCOME_PREFIX}${zoneId}/${recommendationId}/${checkpoint}.json`;
}

/** A checkpoint outcome persisted to R2. */
export interface CheckpointOutcome {
  schemaVersion: 1;
  zoneId: string;
  hostname: string;
  recommendationId: string;
  cloudflareRuleId?: string;
  appliedAt: string;
  checkpoint: MonitoringCheckpoint;
  endDay: string;
  generatedAt: string;
  pre: {
    daysPresent: number;
    daysExpected: number;
    missingDays: string[];
    truncatedGroupingSets: string[];
    requestCount: number;
    bytes: number;
  };
  post: {
    daysPresent: number;
    daysExpected: number;
    missingDays: string[];
    truncatedGroupingSets: string[];
    requestCount: number;
    bytes: number;
  };
  /** The exact non-overlapping pre-window days used. */
  preDays: string[];
  /** The exact non-overlapping post-window days used. */
  postDays: string[];
  /** Supported metrics only (values). Unavailable metrics are recorded in `unavailableMetrics`. */
  supportedMetrics: { metric: string; value: number; percentChange?: number }[];
  /** The metrics this checkpoint explicitly reports unavailable. */
  unavailableMetrics: string[];
  fullCoverage: boolean;
  /** SHA-256 over the canonical content of this object (excluding this field). */
  sha256: string;
}

/** Build the canonical persisted outcome from a monitoring report. */
export function outcomeFromReport(
  report: MonitoringReport,
  generatedAt: string,
): Omit<CheckpointOutcome, "sha256"> {
  return {
    schemaVersion: 1,
    zoneId: report.zoneId,
    hostname: report.hostname,
    recommendationId: report.recommendationId,
    cloudflareRuleId: report.cloudflareRuleId,
    appliedAt: report.appliedAt,
    checkpoint: report.checkpoint,
    endDay: report.endDay,
    generatedAt,
    pre: { ...report.pre },
    post: { ...report.post },
    preDays: report.preDays,
    postDays: report.postDays,
    supportedMetrics: report.metrics
      .filter((m) => m.available && m.value !== undefined)
      .map((m) => ({
        metric: m.metric,
        value: m.value as number,
        ...(m.percentChange !== undefined ? { percentChange: m.percentChange } : {}),
      })),
    unavailableMetrics: report.metrics.filter((m) => !m.available).map((m) => m.metric),
    fullCoverage: report.fullCoverage,
  };
}

/** Serialize an outcome deterministically. */
function outcomeBody(outcome: Omit<CheckpointOutcome, "sha256">): string {
  return canonicalJson(outcome);
}

/**
 * Write a checkpoint outcome idempotently. The key is deterministic and the
 * write is a plain overwrite, so a retried run converges. The object's own
 * `sha256` is the integrity hash over its canonical content.
 */
export async function writeOutcome(
  bucket: R2Store,
  report: MonitoringReport,
  generatedAt: string,
): Promise<string> {
  const content = outcomeFromReport(report, generatedAt);
  const key = outcomeKey(report.zoneId, report.recommendationId, report.checkpoint);
  const outcome: CheckpointOutcome = { ...content, sha256: sha256(content) };
  await bucket.put(key, outcomeBody(outcome), {
    customMetadata: {
      zoneId: report.zoneId,
      recommendationId: report.recommendationId,
      checkpoint: report.checkpoint,
      sha256: outcome.sha256,
    },
  });
  return key;
}