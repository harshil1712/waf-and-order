/**
 * Signed, expiring, single-use approval reply token.
 *
 * The token is an opaque bearer capability bound to exactly one decision
 * (`APPLY`) for one recommendation in one zone agent. It is HMAC-SHA256 signed
 * with a Worker secret using the Web Crypto API, rendered as safe base64url,
 * and verified in constant time. The signed envelope carries:
 *
 *   version, tokenId, zoneId, recommendationId, decision, expiresAt
 *
 * Possession of a valid, unexpired token is what grants the action — the
 * sender is a supplemental check only. One-time use is enforced by the zone
 * agent's persisted state machine, not by the token itself.
 * The token is never sent into model context.
 */

import { sha256Bytes } from "./canonical.ts";

/** Current token version. Bump to invalidate all previously issued tokens. */
export const TOKEN_VERSION = 1;

/** The one decision a token may authorize in the MVP. */
export type ApprovalDecision = "APPLY";

/** The token signature algorithm label embedded for future rotation. */
const SIG_ALG = "hmac-sha256";

/** The signed payload embedded in every token. */
export interface TokenPayload {
  version: number;
  tokenId: string;
  zoneId: string;
  recommendationId: string;
  decision: ApprovalDecision;
  /** ISO expiry timestamp. */
  expiresAt: string;
}

/** A validated token and the payload it carries. */
export interface VerifiedToken {
  tokenId: string;
  zoneId: string;
  recommendationId: string;
  decision: ApprovalDecision;
  expiresAt: string;
  version: number;
}

/** Encode arbitrary bytes to URL-safe base64 (RFC 4648 §5, no padding). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Decode URL-safe base64 back to bytes. Throws on invalid input. */
export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive an HMAC-SHA256 signing key from a Worker secret via Web Crypto. */
async function importKey(secret: string): Promise<CryptoKey> {
  const data = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    data,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The exact string that is signed (canonical payload). */
function signingInput(payload: TokenPayload): string {
  return [
    payload.version,
    payload.tokenId,
    payload.zoneId,
    payload.recommendationId,
    payload.decision,
    payload.expiresAt,
    SIG_ALG,
  ].join("\n");
}

/**
 * Sign and encode a token. The payload embeds the expiry; the token id is the
 * server-side record key consumed atomically with the approval transition.
 */
export async function signToken(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput(payload)),
  );
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sigB64 = toBase64Url(new Uint8Array(mac));
  return `${payloadB64}.${sigB64}`;
}

/** Split an encoded token into payload and signature parts, or null. */
export function splitToken(token: string): { payloadB64: string; sigB64: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return null;
  return { payloadB64, sigB64 };
}

/** Constant-time byte comparison of two equal-length byte arrays. */
export async function constantTimeEqual(
  a: Uint8Array,
  b: Uint8Array,
): Promise<boolean> {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A verification failure reason; exposed for tests and logging. */
export type TokenVerifyError =
  | "malformed"
  | "invalid_signature"
  | "expired"
  | "wrong_version"
  | "not_apply";

export interface TokenVerifyResult {
  ok: boolean;
  error?: TokenVerifyError;
  payload?: VerifiedToken;
}

/**
 * Verify an encoded token against the signing secret. Checks version,
 * signature (constant-time), decision, and expiry. Note: single-use and
 * recommendation/zone binding are enforced against persistent state by the
 * zone agent, not here — this function validates the bearer
 * capability itself.
 */
export async function verifyToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): Promise<TokenVerifyResult> {
  const parts = splitToken(token);
  if (!parts) return { ok: false, error: "malformed" };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(parts.payloadB64)),
    ) as TokenPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }

  if (payload.version !== TOKEN_VERSION) {
    return { ok: false, error: "wrong_version" };
  }
  if (payload.decision !== "APPLY") {
    return { ok: false, error: "not_apply" };
  }

  const key = await importKey(secret);
  const expectedMac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput(payload)),
  );
  const suppliedMac = fromBase64Url(parts.sigB64);
  const sigOk = await constantTimeEqual(new Uint8Array(expectedMac), suppliedMac);
  if (!sigOk) return { ok: false, error: "invalid_signature" };

  if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, error: "expired" };
  }

  return {
    ok: true,
    payload: {
      tokenId: payload.tokenId,
      zoneId: payload.zoneId,
      recommendationId: payload.recommendationId,
      decision: payload.decision,
      expiresAt: payload.expiresAt,
      version: payload.version,
    },
  };
}

/** Verify a token encoded in a Reply-To address and extract its payload. */
export async function extractTokenFromAddress(
  address: string,
  secret: string,
  now?: Date,
): Promise<TokenVerifyResult> {
  const match = /^approve\+([^@]+)@/i.exec(address.trim());
  if (!match) return { ok: false, error: "malformed" };
  return verifyToken(match[1], secret, now);
}
