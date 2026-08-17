/**
 * Sanitization of attacker-controlled traffic strings.
 *
 * Paths, user agents, referrers, hostnames and other traffic-derived fields
 * are untrusted input. Before any string is persisted or rendered into a
 * report it must be truncated to a bounded length and HTML-escaped. Raw values
 * are never embedded into the system prompt or rendered unescaped.
 */

/** Maximum length of a single traffic string persisted or rendered. */
export const MAX_TRAFFIC_STRING_LENGTH = 256;

/** Truncate a traffic string to a bounded length, preserving a stable suffix. */
export function truncateTrafficString(value: string, maxLength = MAX_TRAFFIC_STRING_LENGTH): string {
  if (value.length <= maxLength) return value;
  const kept = maxLength - 1;
  return `${value.slice(0, kept)}…`;
}

/** HTML-escape a traffic string so it cannot inject markup into a report. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitize a dimensional value before it is persisted or rendered. Strings
 * that came from traffic (paths, user agents, sources, countries) are escaped
 * and truncated; booleans and numbers pass through.
 */
export function sanitizeDimensionValue(
  key: string,
  value: string | boolean | number | null,
): string | boolean | number | null {
  if (typeof value === "string") {
    return truncateTrafficString(value);
  }
  return value;
}