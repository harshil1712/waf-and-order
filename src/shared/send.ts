/**
 * Report delivery abstraction.
 *
 * Report delivery is mockable so tests do not call a live email transport;
 * production uses the Cloudflare Email Sending adapter.
 */

/** The outcome of a send attempt. */
export interface SendReportResult {
  sent: boolean;
  /** Transport identifier, e.g. `noop` or `cloudflare-email`. */
  transport: string;
  detail: string;
  reportId: string;
}

/** A report ready for delivery: rendered HTML and plain text versions. */
export interface ReportSendRequest {
  zoneId: string;
  reportId: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Optional signed `Reply-To` carrying an approval token for one
   * recommendation. Resolved from persistent state, not
   * from model context.
   */
  replyTo?: string;
}

/** The mockable report-sender surface. */
export interface ReportSender {
  send(request: ReportSendRequest): Promise<SendReportResult>;
}

/** Build a human-readable email subject from the report scope. */
export function reportSubject(hostname: string, endDay: string): string {
  return `Bot Traffic Weekly Report — ${hostname} (week ending ${endDay})`;
}
