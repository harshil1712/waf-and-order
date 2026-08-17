/**
 * Envelope sender allowlist.
 *
 * `message.from` is the SMTP MAIL FROM envelope sender. Matching it against the
 * zone's allowed senders is a SUPPLEMENTAL check, not strong identity: it helps
 * filter obvious spoofing but does not by itself authorize an action.
 * Authorization rests on the bearer capability plus the agent's expected-state
 * transition.
 */

/**
 * Normalize an email address to a comparable lowercase form. Handles the
 * `Name <addr>` display format and strips surrounding whitespace and brackets.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const angle = /<([^<>]+)>/.exec(trimmed);
  let core = angle ? angle[1] : trimmed;
  core = core.replace(/^"|"$/g, "").trim();
  // If the core still looks like "a@b", take it; otherwise return normalized.
  const email = /[^\s]+@[^\s]+/.exec(core);
  return (email ? email[0] : core).toLowerCase();
}

/** Parse a display-name address into its bare email, or null. */
export function parseEmail(address: string): string | null {
  const normalized = normalizeAddress(address);
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(normalized);
  return match ? match[0] : null;
}

/** Whether an envelope sender is in the zone's allowed-sender set. */
export function isAllowedEnvelopeSender(
  envelopeFrom: string,
  allowedSenders: readonly string[],
): boolean {
  const sender = parseEmail(envelopeFrom);
  if (!sender) return false;
  return allowedSenders.map(normalizeAddress).includes(sender);
}