import { describe, expect, it } from "vitest";

import {
  classifyMessageKind,
  isBounceEnvelope,
  isBounceSubject,
  isVacationSubject,
} from "../src/shared/auto-reply.ts";

function headers(entries: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(entries)) h.set(k, v);
  return h;
}

describe("bounce envelope", () => {
  it("flags an empty envelope sender as a bounce", () => {
    expect(isBounceEnvelope("")).toBe(true);
    expect(isBounceEnvelope("<>")).toBe(true);
  });
  it("does not flag a normal sender", () => {
    expect(isBounceEnvelope("approver@example.com")).toBe(false);
  });
});

describe("bounce / vacation subjects", () => {
  it("detects bounce subjects", () => {
    expect(isBounceSubject("Undeliverable: Your message")).toBe(true);
    expect(isBounceSubject("Mail delivery failed: returning message to sender")).toBe(true);
    expect(isBounceSubject("Delivery Status Notification (Failure)")).toBe(true);
    expect(isBounceSubject("Hi there")).toBe(false);
  });
  it("detects vacation / out-of-office subjects", () => {
    expect(isVacationSubject("Out of Office")).toBe(true);
    expect(isVacationSubject("Auto: I am on vacation")).toBe(true);
    expect(isVacationSubject("Automatic reply: I'm on leave")).toBe(true);
    expect(isVacationSubject("Weekly report")).toBe(false);
  });
});

describe("classifyMessageKind", () => {
  it("classifies a normal approval candidate", () => {
    const kind = classifyMessageKind(
      { from: "approver@example.com", to: "approve+tok@example.com" },
      headers({ subject: "Re: Weekly report" }),
      {},
    );
    expect(kind.kind).toBe("approval_candidate");
  });

  it("rejects a bounce with empty envelope sender", () => {
    const kind = classifyMessageKind({ from: "", to: "approve+tok@example.com" }, headers({}), {});
    expect(kind.kind).toBe("bounce");
  });

  it("rejects an auto-submitted automated message", () => {
    const kind = classifyMessageKind(
      { from: "approver@example.com", to: "approve+tok@example.com" },
      headers({ "auto-submitted": "auto-replied" }),
      {},
    );
    expect(kind.kind).toBe("automated");
  });

  it("rejects a vacation responder via subject", () => {
    const kind = classifyMessageKind(
      { from: "approver@example.com", to: "approve+tok@example.com" },
      headers({ subject: "Out of Office" }),
      {},
    );
    expect(kind.kind).toBe("vacation");
  });

  it("rejects a delivery-status content type", () => {
    const kind = classifyMessageKind(
      { from: "mailer@example.com", to: "approve+tok@example.com" },
      headers({ "content-type": "multipart/report; report-type=delivery-status" }),
      {},
    );
    expect(kind.kind).toBe("bounce");
  });

  it("rejects an automated precedence", () => {
    const kind = classifyMessageKind(
      { from: "approver@example.com", to: "approve+tok@example.com" },
      headers({ precedence: "auto_reply" }),
      {},
    );
    expect(kind.kind).toBe("automated");
  });
});