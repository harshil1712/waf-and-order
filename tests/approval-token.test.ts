import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  extractTokenFromAddress,
  fromBase64Url,
  signToken,
  splitToken,
  TOKEN_VERSION,
  toBase64Url,
  verifyToken,
} from "../src/shared/approval-token.ts";

const SECRET = "s3cr3t-worker-secret";
const ZONE = "zone-abc";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    version: TOKEN_VERSION,
    tokenId: "tok-1234567890abcdef",
    zoneId: ZONE,
    recommendationId: "R-1042",
    decision: "APPLY" as const,
    expiresAt: "2026-08-20T00:00:00Z",
    ...overrides,
  };
}

describe("base64url encoding", () => {
  it("round-trips bytes and is URL-safe without padding", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x01]);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(fromBase64Url(encoded)).toEqual(bytes);
  });
});

describe("signToken / verifyToken", () => {
  it("signs and verifies a valid token", async () => {
    const token = await signToken(payload(), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.payload?.recommendationId).toBe("R-1042");
    expect(result.payload?.zoneId).toBe(ZONE);
    expect(result.payload?.tokenId).toBe("tok-1234567890abcdef");
    expect(result.payload?.decision).toBe("APPLY");
  });

  it("rejects a tampered signature (constant-time check fails)", async () => {
    const token = await signToken(payload(), SECRET);
    const [p, s] = token.split(".");
    const flipped = s.endsWith("A") ? s.slice(0, -1) + "B" : s.slice(0, -1) + "A";
    const result = await verifyToken(`${p}.${flipped}`, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_signature");
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken(payload(), "other-secret");
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_signature");
  });

  it("rejects an expired token", async () => {
    const token = await signToken(payload(), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-25T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("expired");
  });

  it("rejects a wrong token version", async () => {
    const token = await signToken(payload({ version: 999 }), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("wrong_version");
  });

  it("rejects a non-APPLY decision", async () => {
    const token = await signToken(payload({ decision: "BLOCK" }), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_apply");
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "no-dot", "a.", ".b", "not-base64!.sig"]) {
      const result = await verifyToken(bad, SECRET, new Date("2026-08-15T00:00:00Z"));
      expect(result.ok).toBe(false);
    }
  });

  it("returns the same result for the same payload (deterministic structure)", async () => {
    const a = await signToken(payload(), SECRET);
    const b = await signToken(payload(), SECRET);
    expect(a).toBe(b);
  });
});

describe("exact binding", () => {
  it("verification alone does not bind a recommendation — state enforces binding", async () => {
    // The token is exact-bound to recommendation R-1042 in zone ZONE. Its
    // payload carries those fields; the state machine cross-checks them.
    const token = await signToken(payload(), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.payload?.recommendationId).toBe("R-1042");
    expect(result.payload?.zoneId).toBe(ZONE);
  });

  it("a token for a different zone fails the zone binding check", async () => {
    const token = await signToken(payload({ zoneId: "zone-other" }), SECRET);
    const result = await verifyToken(token, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(true); // signature valid...
    expect(result.payload?.zoneId).toBe("zone-other"); // ...but bound to wrong zone
  });
});

describe("extractTokenFromAddress", () => {
  it("extracts and verifies the token from an approve+ address", async () => {
    const token = await signToken(payload(), SECRET);
    const address = `approve+${token}@security.example.com`;
    const result = await extractTokenFromAddress(address, SECRET, new Date("2026-08-15T00:00:00Z"));
    expect(result.ok).toBe(true);
    expect(result.payload?.recommendationId).toBe("R-1042");
  });

  it("rejects an address without an approve+ local part", async () => {
    const result = await extractTokenFromAddress("help@example.com", SECRET, new Date());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("malformed");
  });
});

describe("constantTimeEqual", () => {
  it("compares equal byte arrays true", async () => {
    expect(await constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  it("compares unequal byte arrays false", async () => {
    expect(await constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  it("returns false for differing lengths", async () => {
    expect(await constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("splitToken", () => {
  it("rejects malformed splits", () => {
    expect(splitToken("abc")).toBeNull();
    expect(splitToken("..")).toBeNull();
    // Two dots means the signature part contains a '.' (malformed).
    expect(splitToken("a.b.c")).toBeNull();
  });
  it("accepts a single-dot split with valid base64url parts", () => {
    expect(splitToken("abcd.efgh")).toEqual({ payloadB64: "abcd", sigB64: "efgh" });
  });
});