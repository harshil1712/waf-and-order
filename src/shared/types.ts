/**
 * Shared persistent-state types for the zone agent.
 *
 * Includes the immutable {@link Recommendation} model, its bound approval token
 * records, and the expected-state transition from `pending_approval` to
 * `approved`. A recommendation is immutable once created: any change to a
 * mutation field must produce a new recommendation `id` and `mutationId`, never
 * an in-place edit.
 */

import type { Recommendation } from "./recommendation.ts";
import type { MonitoringCheckpoint } from "../analytics/monitor.ts";

export type { Recommendation } from "./recommendation.ts";

/**
 * A signed, expiring, single-use reply token record bound to exactly one
 * recommendation and one decision. Held in zone persistent
 * state; consumed atomically with the pending_approval → approved transition.
 */
export interface ApprovalTokenRecord {
  /** The opaque random nonce / token id. Never the bearer signature itself. */
  tokenId: string;
  recommendationId: string;
  zoneId: string;
  decision: "APPLY";
  createdAt: string;
  expiresAt: string;
  /** The token payload bound to this record (signed envelope). */
  payload: string;
  /** The signed bearer token, stored to reconstruct the Reply-To address. */
  signedToken: string;
  /** Set when the token is consumed by the recommendation's approval transition. */
  consumedAt?: string;
  /** The submission id that performed the consuming transition. */
  consumedBy?: string;
}

/** One recommendation whose approval was recorded. */
export interface ApprovedRecord {
  recommendationId: string;
  mutationId: string;
  payloadHash: string;
  approvedAt: string;
  approvalTokenId: string;
  status: "approved";
}

export interface BaselineSummary {
  periodStart: string;
  periodEnd: string;
  requestCount: number;
}

export interface AppliedRule {
  recommendationId: string;
  cloudflareRuleId: string;
  /** The exact immutable mutation applied (authoritative record). */
  mutationId: string;
  payloadHash: string;
  appliedAt: string;
  /** `applied` while the rule is in place; `rolled_back` after guarded rollback. */
  status: "applied" | "rolled_back";
}

export interface RecommendationOutcome {
  recommendationId: string;
  status: "monitoring" | "completed" | "rolled_back";
  summary: string;
}

export interface ReportPreferences {
  timezone: string;
  includeHtml: boolean;
  includeText: boolean;
}

/** A concise record of one monitoring checkpoint outcome held in agent state. */
export interface MonitoringRecord {
  recommendationId: string;
  checkpoint: MonitoringCheckpoint;
  /** R2 key where the full outcome object was persisted. */
  outcomeKey: string;
  endDay: string;
  generatedAt: string;
  /** Whether the checkpoint reached full pre/post coverage. */
  fullCoverage: boolean;
}

/** Rollback lifecycle status for an applied recommendation. */
export type RollbackStatus = "rollback_recommended" | "rolled_back" | "completed";

/** A concise rollback lifecycle record held in agent state. */
export interface RollbackOutcome {
  recommendationId: string;
  status: RollbackStatus;
  summary: string;
  updatedAt: string;
}

/**
 * Zone agent persistent state. `schemaVersion` remains 2 because later-added
 * monitoring fields are optional. Older serialized records therefore load with
 * empty defaults without a forced migration.
 */
export interface ZoneAgentState {
  schemaVersion: 2;
  zoneId: string;
  hostname?: string;
  baselineSummary?: BaselineSummary;
  /** Immutable recommendations awaiting or having received an approval decision. */
  recommendations: Recommendation[];
  /** Signed reply-token records; consumed atomically with approval transitions. */
  approvalTokens: ApprovalTokenRecord[];
  /** Recorded approval transitions. */
  approvedRecords: ApprovedRecord[];
  /** Envelope senders authorized to approve (supplemental check). */
  allowedEnvelopeSenders: string[];
  appliedRules: AppliedRule[];
  recentOutcomes: RecommendationOutcome[];
  reportPreferences: ReportPreferences;
  lastDailyCollectionAt?: string;
  lastWeeklyReportAt?: string;
  /**
   * The latest completed monitoring endDay (YYYY-MM-DD) persisted from the most
   * recent `monitoring.check.due` signal. Used by the monitor tool to compute
   * checkpoint due-ness; updated monotonically (older/replayed signals never
   * move it backward) so it survives intervening tool calls/renders and replay.
   * Optional for backward compatibility with older persisted states.
   */
  lastMonitoringEndDay?: string;
  /**
   * Concise checkpoint-outcome records. Optional in older persisted states and
   * defaults to empty. The full outcome object lives in R2.
   */
  monitoringRecords?: MonitoringRecord[];
  /** Rollback lifecycle records. Optional in older states; defaults to empty. */
  rollbackOutcomes?: RollbackOutcome[];
}
