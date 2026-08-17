/**
 * Automated / bounce / vacation responder detection.
 *
 * Bounces, vacation responders, and automated messages must be rejected before
 * any approval is dispatched. Detection inspects the envelope headers
 * (`message.headers`) plus the parsed MIME headers (`postal-mime`), both of
 * which are untrusted input. Detection is conservative: an empty envelope
 * sender and delivery-status headers are strong signals.
 */

/** A classification of the inbound message kind. */
export interface MessageKind {
  kind: "approval_candidate" | "bounce" | "vacation" | "automated" | "auto_reply";
  reason?: string;
}

/** Envelope-derived facts. */
export interface EnvelopeFacts {
  /** The SMTP MAIL FROM envelope sender; empty for bounces. */
  from: string;
  /** The SMTP RCPT TO envelope recipient. */
  to: string;
}

/**
 * Inspect the envelope sender. An empty sender (`<>` or empty) is the classic
 * bounce marker.
 */
export function isBounceEnvelope(envelopeFrom: string): boolean {
  const sender = envelopeFrom.trim();
  return sender === "" || sender === "<>";
}

/** Lowercase a header value or return an empty string. */
function headerValue(headers: Headers | null, name: string): string {
  if (!headers) return "";
  return headers.get(name) ?? "";
}

/**
 * Classify an inbound message. Returns `approval_candidate` only when there is
 * no bounce, vacation, or automated-message signal.
 *
 * @param envelope SMTP envelope facts (sender may be empty for bounces).
 * @param headers The raw `message.headers` (envelope headers).
 * @param mimeHeaders Optional parsed MIME headers (postal-mime) for extra checks.
 */
export function classifyMessageKind(
  envelope: EnvelopeFacts,
  headers: Headers | null,
  mimeHeaders: Record<string, string[]> = {},
): MessageKind {
  if (isBounceEnvelope(envelope.from)) {
    return { kind: "bounce", reason: "empty envelope sender (bounce)" };
  }

  const autoSubmitted = headerValue(headers, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { kind: "automated", reason: `auto-submitted: ${autoSubmitted}` };
  }

  const autoResponseSuppress = headerValue(headers, "x-auto-response-suppress").toLowerCase();
  if (autoResponseSuppress && autoResponseSuppress !== "all") {
    return { kind: "automated", reason: "x-auto-response-suppress present" };
  }

  const subject = (headerValue(headers, "subject") || mimeHeaders.subject?.join(" ") || "").toLowerCase();
  if (isBounceSubject(subject)) {
    return { kind: "bounce", reason: "bounce subject" };
  }
  if (isVacationSubject(subject)) {
    return { kind: "vacation", reason: "vacation subject" };
  }

  // Precedence header: auto_reply / bulk / list mark automated traffic.
  const precedence = headerValue(headers, "precedence").toLowerCase();
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "list") {
    return { kind: "automated", reason: `precedence: ${precedence}` };
  }

  // A delivery-status notification or a bounce content-type is definitive.
  const contentType = (
    headerValue(headers, "content-type") ||
    mimeHeaders["content-type"]?.join(" ") ||
    ""
  ).toLowerCase();
  if (
    contentType.includes("report/delivery-status") ||
    contentType.includes("message/delivery-status") ||
    contentType.includes("report-type=delivery-status")
  ) {
    return { kind: "bounce", reason: "delivery-status content type" };
  }

  return { kind: "approval_candidate" };
}

/** Heuristic: does a subject look like a bounce or delivery failure? */
export function isBounceSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return (
    s.includes("undeliverable") ||
    s.includes("delivery status notification") ||
    s.includes("delivery failure") ||
    s.includes("delivery failed") ||
    s.includes("mail delivery failed") ||
    s.includes("mail delivery system") ||
    s.includes("failure notice") ||
    s.includes("returned mail") ||
    s.includes("returned message") ||
    s.includes("mailer-daemon")
  );
}

/** Heuristic: does a subject look like a vacation / out-of-office reply? */
export function isVacationSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return (
    s.startsWith("auto:") ||
    s.startsWith("re: auto") ||
    s.includes("out of office") ||
    s.includes("out of the office") ||
    s.includes("automatic reply") ||
    s.includes("vacation") ||
    s.includes("on leave")
  );
}