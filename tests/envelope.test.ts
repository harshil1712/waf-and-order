import { describe, expect, it } from "vitest";

import {
  isAllowedEnvelopeSender,
  normalizeAddress,
  parseEmail,
} from "../src/shared/envelope.ts";

const ALLOWED = ["approver@example.com", "ops@example.com"];

describe("normalizeAddress", () => {
  it("normalizes display-name and bracket forms to a bare lowercase email", () => {
    expect(normalizeAddress('"Ops" <OPS@Example.COM>')).toBe("ops@example.com");
    expect(normalizeAddress("ops@example.com")).toBe("ops@example.com");
    expect(normalizeAddress("  APPROVER@example.com ")).toBe("approver@example.com");
  });
});

describe("parseEmail", () => {
  it("extracts a bare email", () => {
    expect(parseEmail("Approver <approver@example.com>")).toBe("approver@example.com");
  });
  it("returns null for non-emails", () => {
    expect(parseEmail("not an email")).toBeNull();
  });
});

describe("isAllowedEnvelopeSender", () => {
  it("accepts an allowed envelope sender", () => {
    expect(isAllowedEnvelopeSender("approver@example.com", ALLOWED)).toBe(true);
  });

  it("accepts an allowed sender in display form with different case", () => {
    expect(isAllowedEnvelopeSender('"Approver" <Approver@Example.COM>', ALLOWED)).toBe(true);
  });

  it("rejects an unauthorized envelope sender", () => {
    expect(isAllowedEnvelopeSender("attacker@evil.example", ALLOWED)).toBe(false);
  });

  it("rejects a spoofed MIME From that is not the envelope sender", () => {
    // Authorization is based on the SMTP envelope sender (message.from), NOT
    // the MIME From header. A spoofed MIME From that isn't in the allowlist
    // does not help; the envelope sender remains authoritative.
    const envelopeFrom = "approver@example.com"; // authorized envelope
    const mimeFrom = "attacker@evil.example"; // spoofed MIME From
    expect(isAllowedEnvelopeSender(envelopeFrom, ALLOWED)).toBe(true);
    // The MIME From alone would be rejected; the envelope wins.
    expect(isAllowedEnvelopeSender(mimeFrom, ALLOWED)).toBe(false);
  });

  it("rejects an empty or unparsable envelope sender", () => {
    expect(isAllowedEnvelopeSender("", ALLOWED)).toBe(false);
    expect(isAllowedEnvelopeSender("<>", ALLOWED)).toBe(false);
  });
});