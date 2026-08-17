/**
 * Cloudflare Email Sending adapter.
 *
 * Sends the weekly report through the `send_email` binding. It FAILS CLOSED:
 * if the binding or the sender/recipient configuration is absent, it throws
 * rather than pretending delivery happened. An unconfigured production send
 * must surface as an error, never as a silent no-op success.
 *
 * The signed `Reply-To` is taken from the per-request {@link ReportSendRequest}
 * (resolved by the send tool from persistent state), never from
 * model context.
 *
 * Tests remain fully mocked: they inject a fake {@link EmailSendBinding} and
 * config rather than calling the real Cloudflare transport.
 */

import type { ReportSendRequest, ReportSender, SendReportResult } from "../shared/send.ts";

/**
 * Confirmation-email request. Carries a
 * stable id (`confirmation:<recommendationId>:<mutationId>`) so a duplicated
 * outbound delivery is recognizable.
 */
export interface ConfirmationSendRequest {
  zoneId: string;
  recommendationId: string;
  cloudflareRuleId: string;
  mutationId: string;
  appliedAt: string;
}

/** Outcome of a confirmation-email send. */
export interface ConfirmationSendResult {
  sent: boolean;
  transport: string;
  detail: string;
}

/** The confirmation-email abstraction (fail-closed; tests inject a fake). */
export interface ConfirmationSender {
  sendConfirmation(request: ConfirmationSendRequest): Promise<ConfirmationSendResult>;
}

/**
 * Build a fail-closed confirmation sender on top of a {@link ReportSender}.
 * The underlying report sender throws {@link EmailSendingUnavailableError} when
 * Email Sending is unprovisioned, so a confirmation never silently no-ops.
 * Tests mock the {@link ReportSender} rather than calling the live transport.
 */
export function cloudflareConfirmationSender(sender: ReportSender): ConfirmationSender {
  return {
    async sendConfirmation(request) {
      const subject = `WAF rule applied — ${request.recommendationId}`;
      const text =
        `Recommendation ${request.recommendationId} was applied as Cloudflare rule ` +
        `${request.cloudflareRuleId} (mutation ${request.mutationId}) at ${request.appliedAt}.`;
      const result = await sender.send({
        zoneId: request.zoneId,
        reportId: `confirmation:${request.recommendationId}:${request.mutationId}`,
        subject,
        html: `<p>${text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}</p>`,
        text,
      });
      return { sent: result.sent, transport: result.transport, detail: result.detail };
    },
  };
}

/**
 * The minimal `send_email` binding surface used by this adapter. It is a narrow
 * structural type satisfied by the generated `SendEmail` binding, so the
 * adapter stays unit-testable with a fake and needs no `as` casts.
 */
export interface EmailSendBinding {
  send(message: {
    to: string;
    from: string | { name?: string; email: string };
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string | { name?: string; email: string };
  }): Promise<{ messageId: string }>;
}

/** Configuration the adapter needs to send. Absent config fails closed. */
export interface CloudflareEmailSenderConfig {
  binding: EmailSendBinding;
  /** Verified sender address/domain, e.g. `security@example.com`. */
  from: string;
  /** Verified report recipient, e.g. the zone's authorized approver. */
  to: string;
}

/** A failure indicating the Email Sending adapter is not usable. */
export class EmailSendingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendingUnavailableError";
  }
}

/**
 * Build a real Cloudflare Email Sending `ReportSender` that fails closed.
 * Throws when the binding or sender/recipient configuration is absent so a
 * misconfigured production send surfaces immediately instead of silently
 * succeeding. The signed Reply-To is the per-request value (never a stored
 * config value), so each report carries exactly the token the send tool
 * resolved for it.
 */
export function cloudflareEmailSender(config: CloudflareEmailSenderConfig): ReportSender {
  if (!config.binding) {
    throw new EmailSendingUnavailableError(
      "Email Sending binding is not configured; refusing to send.",
    );
  }
  if (!config.from || !config.to) {
    throw new EmailSendingUnavailableError(
      "Email Sending sender/recipient config is absent; refusing to send.",
    );
  }

  return {
    async send(request: ReportSendRequest): Promise<SendReportResult> {
      const result = await config.binding.send({
        to: config.to,
        from: config.from,
        subject: request.subject,
        text: request.text,
        html: request.html,
        // Per-request signed Reply-To; undefined when none.
        replyTo: request.replyTo,
      });
      return {
        sent: true,
        transport: "cloudflare-email",
        detail: `Sent via Cloudflare Email Sending (${result.messageId}).`,
        reportId: request.reportId,
      };
    },
  };
}
