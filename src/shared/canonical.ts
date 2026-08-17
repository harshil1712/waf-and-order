import { createHash } from "node:crypto";

/**
 * Serialize a JSON value with a stable, deterministic byte layout so the same
 * logical object always hashes to the same digest regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Deterministic object-key ordering used by {@link canonicalJson}. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex digest of a canonicalized JSON value. */
export function sha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

/** SHA-256 hex digest of raw bytes. */
export function sha256Bytes(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return createHash("sha256").update(data).digest("hex");
}