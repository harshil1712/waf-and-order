/**
 * Inbound approval-email decision engine.
 *
 * This module is PURE and unit-testable: given the SMTP envelope facts, the raw
 * MIME bytes (buffered once), an injectable MIME parser, and the zone config,
 * it decides whether to dispatch a verified approval signal. It performs the
 * full inbound pipeline:
 *
 *   1. Extract + validate the signed token from the envelope recipient.
 *   2. Match the envelope sender against the allowed-sender allowlist
 *      (supplemental — never strong identity).
 *   3. Reject bounces, vacation responders, and automated messages.
 *   4. Buffer `message.raw` once and parse MIME.
 *   5. Extract the first new meaningful reply line, excluding quoted content.
 *   6. Require an exact `APPLY <id>` command whose id matches the token.
 *
 * It does NOT consume or mark the token; that happens inside the zone agent's
 * atomic persisted-state transition. It never returns the
 * token or the MIME body into model context — only the recommendation id and
 * token id.
 */

import { classifyMessageKind } from "../shared/auto-reply.ts";
import { extractTokenFromAddress, type VerifiedToken } from "../shared/approval-token.ts";
import { parseApplyCommand } from "../shared/apply-parser.ts";
import { isAllowedEnvelopeSender, normalizeAddress } from "../shared/envelope.ts";

/** A parsed MIME email, reduced to what the decision needs. */
export interface ParsedMime {
  /** The plain-text body (attacker-controlled; never trusted as instructions). */
  text?: string;
  /** Lowercase header name → value(s). */
  headers: Record<string, string[]>;
  /** The MIME From header, parsed address (NOT used for authorization). */
  mimeFrom?: string;
}

/** An injectable MIME parser so postal-mime is only exercised in the glue. */
export type MimeParser = (raw: string) => Promise<ParsedMime>;

/** The SMTP envelope facts passed to the handler. */
export interface InboundEnvelope {
  /** Envelope MAIL FROM sender (empty for bounces). */
  from: string;
  /** Envelope RCPT TO recipient. */
  to: string;
}

/** Zone config the inbound decision needs. */
export interface InboundConfig {
  zoneId: string;
  secret: string;
  /** Allowed envelope senders (supplemental check). */
  allowedSenders: string[];
  /** Inject "now" for deterministic expiry tests. */
  now?: Date;
  /** Real envelope headers (message.headers) for automated/bounce detection. */
  envelopeHeaders?: Headers | null;
}

/** A dispatch intent: everything the agent needs, with no token/body. */
export interface ApprovalDispatch {
  recommendationId: string;
  approvalTokenId: string;
  zoneId: string;
  /** Flue 2.0.3 idempotencyKey: retried deliveries converge on one submission. */
  idempotencyKey: string;
}

/** The outcome of inbound processing. */
export type InboundDecision =
  | { ok: true; dispatch: ApprovalDispatch }
  | { ok: false; rejected: boolean; reason: string };

/** Number of raw bytes read at most once (bounded). */
const MAX_RAW_EMAIL_BYTES = 2 * 1024 * 1024;

/** A postal-mime-backed parser factory (used by the Worker glue). */
async function parseMimeWithPostalMime(raw: string): Promise<ParsedMime> {
  const { default: PostalMime } = await import("postal-mime");
  const parsed = await PostalMime.parse(new TextEncoder().encode(raw).buffer as ArrayBuffer);
  const headers: Record<string, string[]> = {};
  for (const header of parsed.headers ?? []) {
    (headers[header.key] ??= []).push(header.value);
  }
  const mimeFrom = parsed.from?.address;
  return { text: parsed.text, headers, mimeFrom };
}

/**
 * Process an inbound approval email and return a verified dispatch or a
 * rejection. This is the single source of truth for the §13.2 pipeline and is
 * shared by the Worker glue and tests.
 */
export async function decideInboundApproval(
  envelope: InboundEnvelope,
  raw: string,
  config: InboundConfig,
  parseMime: MimeParser = parseMimeWithPostalMime,
): Promise<InboundDecision> {
  const now = config.now ?? new Date();

  // 1. Extract + validate the signed token from the envelope recipient.
  const tokenResult = await extractTokenFromAddress(envelope.to, config.secret, now);
  if (!tokenResult.ok || !tokenResult.payload) {
    return { ok: false, rejected: true, reason: `invalid_token:${tokenResult.error}` };
  }
  const token: VerifiedToken = tokenResult.payload;

  // The token must be bound to this zone agent.
  if (token.zoneId !== config.zoneId) {
    return { ok: false, rejected: true, reason: "token_zone_mismatch" };
  }

  // 2. Envelope sender allowlist (supplemental check).
  if (!isAllowedEnvelopeSender(envelope.from, config.allowedSenders)) {
    return { ok: false, rejected: true, reason: "unauthorized_sender" };
  }

  // 3. Reject bounces / vacation / automated (uses envelope + raw headers).
  // The raw MIME headers are parsed below; classify first on envelope-level
  // signals available without parsing, then re-check after parsing.
  const kind = classifyMessageKind(
    { from: envelope.from, to: envelope.to },
    config.envelopeHeaders ?? null,
    {},
  );
  if (kind.kind !== "approval_candidate") {
    return { ok: false, rejected: true, reason: kind.reason ?? "not_approval_candidate" };
  }

  // 4. Buffer raw once and parse MIME.
  if (raw.length > MAX_RAW_EMAIL_BYTES) {
    return { ok: false, rejected: true, reason: "raw_too_large" };
  }
  let parsed: ParsedMime;
  try {
    parsed = await parseMime(raw);
  } catch {
    return { ok: false, rejected: true, reason: "mime_parse_failed" };
  }

  // Re-check automated/vacation/bounce using parsed MIME headers (subject,
  // content-type). The envelope sender stays authoritative for authorization.
  const kindWithMime = classifyMessageKind(
    { from: envelope.from, to: envelope.to },
    config.envelopeHeaders ?? null,
    parsed.headers,
  );
  if (kindWithMime.kind !== "approval_candidate") {
    return { ok: false, rejected: true, reason: kindWithMime.reason ?? "not_approval_candidate" };
  }

  // 5. Extract the first new meaningful reply line, excluding quoted content.
  const body = parsed.text ?? "";
  const command = parseApplyCommand(body);

  // 6. Require an exact APPLY <id> matching the token's recommendation.
  if (!command.ok || !command.recommendationId) {
    return { ok: false, rejected: true, reason: command.reason ?? "not_an_apply_command" };
  }
  if (command.recommendationId !== token.recommendationId) {
    return { ok: false, rejected: true, reason: "apply_recommendation_mismatch" };
  }

  return {
    ok: true,
    dispatch: {
      recommendationId: token.recommendationId,
      approvalTokenId: token.tokenId,
      zoneId: config.zoneId,
      idempotencyKey: `approve:${token.tokenId}`,
    },
  };
}