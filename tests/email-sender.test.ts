import { describe, expect, it } from "vitest";

import {
  cloudflareEmailSender,
  cloudflareConfirmationSender,
  EmailSendingUnavailableError,
  type EmailSendBinding,
} from "../src/email/sender.ts";

function fakeBinding(): EmailSendBinding {
  return {
    send: async (message) => {
      return { messageId: `msg-${message.to}-${message.subject.length}` };
    },
  };
}

describe("cloudflareEmailSender", () => {
  it("sends a report through the Email Sending binding when configured", async () => {
    const binding = fakeBinding();
    const sender = cloudflareEmailSender({
      binding,
      from: "security@example.com",
      to: "approver@example.com",
    });
    const result = await sender.send({
      zoneId: "zone-abc",
      reportId: "report-x",
      subject: "Bot Traffic Weekly Report",
      html: "<h1>Hi</h1>",
      text: "Hi",
    });
    expect(result.sent).toBe(true);
    expect(result.transport).toBe("cloudflare-email");
    expect(result.reportId).toBe("report-x");
  });

  it("fails closed when the binding is absent", () => {
    expect(() =>
      cloudflareEmailSender({ binding: undefined as never, from: "a@b", to: "c@d" }),
    ).toThrow(EmailSendingUnavailableError);
  });

  it("fails closed when sender config is absent", () => {
    expect(() =>
      cloudflareEmailSender({ binding: fakeBinding(), from: "", to: "c@d" }),
    ).toThrow(EmailSendingUnavailableError);
  });

  it("fails closed when recipient config is absent", () => {
    expect(() =>
      cloudflareEmailSender({ binding: fakeBinding(), from: "a@b", to: "" }),
    ).toThrow(EmailSendingUnavailableError);
  });

  it("passes the per-request Reply-To carrying the approval token", async () => {
    let captured: { replyTo?: string } | undefined;
    const binding: EmailSendBinding = {
      send: async (message) => {
        captured = { replyTo: message.replyTo as string | undefined };
        return { messageId: "m1" };
      },
    };
    const sender = cloudflareEmailSender({
      binding,
      from: "security@example.com",
      to: "approver@example.com",
    });
    await sender.send({
      zoneId: "z",
      reportId: "r",
      subject: "s",
      html: "",
      text: "",
      replyTo: "approve+token@security.example.com",
    });
    expect(captured?.replyTo).toBe("approve+token@security.example.com");
  });

  it("omits Reply-To when the request carries none", async () => {
    let captured: { replyTo?: string } | undefined;
    const binding: EmailSendBinding = {
      send: async (message) => {
        captured = { replyTo: message.replyTo as string | undefined };
        return { messageId: "m2" };
      },
    };
    const sender = cloudflareEmailSender({
      binding,
      from: "security@example.com",
      to: "approver@example.com",
    });
    await sender.send({ zoneId: "z", reportId: "r", subject: "s", html: "", text: "" });
    expect(captured?.replyTo).toBeUndefined();
  });
});

describe("cloudflareConfirmationSender", () => {
  it("sends a confirmation through a fail-closed report sender with a stable report id", async () => {
    let captured: { reportId: string; subject: string } | undefined;
    const reportSender = {
      send: async (req: { reportId: string; subject: string }) => {
        captured = { reportId: req.reportId, subject: req.subject };
        return { sent: true, transport: "cloudflare-email", detail: "msg-1", reportId: req.reportId };
      },
    };
    const confirmation = cloudflareConfirmationSender(reportSender);
    const result = await confirmation.sendConfirmation({
      zoneId: "z",
      recommendationId: "R-1042",
      cloudflareRuleId: "cf-rule-1",
      mutationId: "m-mut",
      appliedAt: "2026-08-15T00:00:00Z",
    });
    expect(result.sent).toBe(true);
    // Stable id so a duplicated outbound delivery is recognizable (§18).
    expect(captured?.reportId).toBe("confirmation:R-1042:m-mut");
    expect(captured?.subject).toContain("R-1042");
  });

  it("fails closed (surfaces the underlying unavailability) when Email Sending is unprovisioned", async () => {
    const failing = {
      send: async () => {
        throw new EmailSendingUnavailableError(
          "Email Sending binding or sender/recipient config is absent; refusing to send.",
        );
      },
    };
    const confirmation = cloudflareConfirmationSender(failing);
    await expect(
      confirmation.sendConfirmation({
        zoneId: "z",
        recommendationId: "R-1042",
        cloudflareRuleId: "cf-1",
        mutationId: "m",
        appliedAt: "2026-08-15T00:00:00Z",
      }),
    ).rejects.toThrow(EmailSendingUnavailableError);
  });
});