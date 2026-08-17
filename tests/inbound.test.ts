import { describe, expect, it } from "vitest";

import {
  decideInboundApproval,
  type InboundDecision,
  type MimeParser,
} from "../src/email/inbound.ts";
import { signToken, TOKEN_VERSION } from "../src/shared/approval-token.ts";

const SECRET = "s3cr3t-secret";
const ZONE = "zone-abc";
const REC_ID = "R-1042";
const TOKEN_ID = "tok-1111111111111111";
const DOMAIN = "security.example.com";
const ALLOWED = ["approver@example.com"];

const NOW = new Date("2026-08-15T00:00:00Z");
const EXPIRES = "2026-08-20T00:00:00Z";

/** A fake MIME parser: returns a body and parsed headers (tests stay mocked). */
function fakeParser(body: string, headers: Record<string, string[]> = {}, mimeFrom?: string): MimeParser {
  return async () => ({ text: body, headers, mimeFrom });
}

function tokenPayload() {
  return {
    version: TOKEN_VERSION,
    tokenId: TOKEN_ID,
    zoneId: ZONE,
    recommendationId: REC_ID,
    decision: "APPLY" as const,
    expiresAt: EXPIRES,
  };
}

function envelope(to = `approve+${TOKEN_ID}@${DOMAIN}`, from = "approver@example.com") {
  return { to, from };
}

/** Narrow a rejection decision and return its reason (for TS type narrowing). */
function rejectionReason(decision: InboundDecision): string {
  if (decision.ok) throw new Error("expected a rejection, got a dispatch");
  return decision.reason;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    zoneId: ZONE,
    secret: SECRET,
    allowedSenders: ALLOWED,
    now: NOW,
    envelopeHeaders: null as Headers | null,
    ...overrides,
  };
}

describe("decideInboundApproval pipeline", () => {
  it("dispatches for a valid authorized APPLY", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042\n",
      baseConfig(),
      fakeParser("APPLY R-1042\n"),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.dispatch.recommendationId).toBe(REC_ID);
      expect(decision.dispatch.approvalTokenId).toBe(TOKEN_ID);
      expect(decision.dispatch.zoneId).toBe(ZONE);
      expect(decision.dispatch.idempotencyKey).toBe(`approve:${TOKEN_ID}`);
    }
  });

  it("never exposes the token or MIME body in the dispatch payload", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042\nsecret body text",
      baseConfig(),
      fakeParser("APPLY R-1042\nsecret body text"),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      const keys = Object.keys(decision.dispatch);
      expect(keys).toEqual(expect.arrayContaining(["recommendationId", "approvalTokenId", "zoneId", "idempotencyKey"]));
      // The signed token string and the MIME body must never leak to the model.
      expect(JSON.stringify(decision.dispatch)).not.toContain(token);
      expect(JSON.stringify(decision.dispatch)).not.toContain("secret body text");
    }
  });

  it("rejects a tampered token", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const [p, s] = token.split(".");
    const bad = `${p}.${s.endsWith("A") ? s.slice(0, -1) + "B" : s.slice(0, -1) + "A"}`;
    const decision = await decideInboundApproval(
      envelope(`approve+${bad}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("invalid_token:invalid_signature");
  });

  it("rejects an expired token", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const late = new Date("2026-08-25T00:00:00Z");
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig({ now: late }),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("invalid_token:expired");
  });

  it("rejects a token bound to a different zone", async () => {
    const token = await signToken({ ...tokenPayload(), zoneId: "zone-other" }, SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("token_zone_mismatch");
  });

  it("rejects an unauthorized envelope sender", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      { to: `approve+${token}@${DOMAIN}`, from: "attacker@evil.example" },
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("unauthorized_sender");
  });

  it("authorizes based on envelope sender, not a spoofed MIME From", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    // Envelope from is authorized; MIME From is spoofed to a non-allowlisted
    // address. The envelope (message.from) is authoritative, so this is allowed.
    const decision = await decideInboundApproval(
      { to: `approve+${token}@${DOMAIN}`, from: "approver@example.com" },
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042", {}, "attacker@evil.example"),
    );
    expect(decision.ok).toBe(true);
  });

  it("rejects a bounce (empty envelope sender)", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      { to: `approve+${token}@${DOMAIN}`, from: "" },
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    // An empty envelope sender is both a bounce signal and not in the
    // allowlist; it is rejected (reason reflects the allowlist failure first).
    expect(rejectionReason(decision)).toMatch(/unauthorized_sender|bounce/);
  });

  it("rejects a vacation responder", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig(),
      fakeParser("APPLY R-1042", { subject: ["Out of Office"] }),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("vacation subject");
  });

  it("rejects an automated auto-submitted message", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig({ envelopeHeaders: new Headers({ "auto-submitted": "auto-replied" }) }),
      fakeParser("APPLY R-1042"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("auto-submitted: auto-replied");
  });

  it("ignores quoted APPLY and parses the first new meaningful line", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const body = `> On Tue you wrote:
> APPLY R-9999

APPLY R-1042

On Wed you forwarded:
APPLY R-8888`;
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      body,
      baseConfig(),
      fakeParser(body),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.dispatch.recommendationId).toBe(REC_ID);
  });

  it("rejects when the only content is a quoted APPLY", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "> APPLY R-1042\n> already quoted",
      baseConfig(),
      fakeParser("> APPLY R-1042\n> already quoted"),
    );
    expect(decision.ok).toBe(false);
  });

  it("rejects when the APPLY command does not match the token's recommendation", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-9999",
      baseConfig(),
      fakeParser("APPLY R-9999"),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("apply_recommendation_mismatch");
  });

  it("rejects APPLY ALL", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY ALL",
      baseConfig(),
      fakeParser("APPLY ALL"),
    );
    expect(decision.ok).toBe(false);
  });

  it("rejects an oversized raw body", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      big,
      baseConfig(),
      fakeParser(big),
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("raw_too_large");
  });

  it("rejects when MIME parsing fails", async () => {
    const token = await signToken(tokenPayload(), SECRET);
    const failing: MimeParser = async () => {
      throw new Error("parse error");
    };
    const decision = await decideInboundApproval(
      envelope(`approve+${token}@${DOMAIN}`),
      "APPLY R-1042",
      baseConfig(),
      failing,
    );
    expect(decision.ok).toBe(false);
    expect(rejectionReason(decision)).toBe("mime_parse_failed");
  });
});