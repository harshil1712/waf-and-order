/**
 * Exact `APPLY <id>` command parser.
 *
 * Takes the FIRST new meaningful line of a reply body and excludes quoted
 * content (lines prefixed with `>`), forwarded headers, and signatures. Only an
 * exact command such as `APPLY R-1042` is accepted — no surrounding words, no
 * `APPLY ALL`, no inline quoted text.
 */

/** A parsed approval command. */
export interface ParsedApplyCommand {
  ok: boolean;
  /** Normalized recommendation id, e.g. `R-1042`. */
  recommendationId?: string;
  reason?: string;
}

/** An id is a valid recommendation reference (e.g. `R-1042`). */
function isRecommendationId(id: string): boolean {
  return /^R-\d+$/.test(id);
}

/**
 * Determine whether a line is "meaningful": non-empty, not a quote (`>`),
 * not a signature boundary (`-- `), and not a forwarded-message delimiter.
 */
export function isMeaningfulLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith(">")) return false;
  if (trimmed === "--" || trimmed.startsWith("-- ")) return false;
  return true;
}

/**
 * Return the first new meaningful line of the reply body. Quoted content,
 * blank lines, signature blocks, and forward delimiters are skipped. The reply
 * is treated as an unstructured body; only the first meaningful line is
 * examined.
 */
export function firstMeaningfulLine(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (isMeaningfulLine(line)) return line.trim();
  }
  return undefined;
}

/** A pure, deterministic regex for an exact APPLY command. */
const APPLY_COMMAND = /^APPLY\s+(R-\d+)$/i;

/**
 * Parse the reply body into an exact `APPLY <id>` command. Only the first new
 * meaningful line is considered; quoted content and everything after is
 * ignored. The keyword is matched case-insensitively but the command must be
 * otherwise exact.
 */
export function parseApplyCommand(body: string): ParsedApplyCommand {
  const first = firstMeaningfulLine(body);
  if (!first) {
    return { ok: false, reason: "empty_reply" };
  }
  const match = APPLY_COMMAND.exec(first);
  if (!match) {
    return { ok: false, reason: "not_an_apply_command" };
  }
  const recommendationId = match[1];
  if (!isRecommendationId(recommendationId)) {
    return { ok: false, reason: "invalid_recommendation_id" };
  }
  return { ok: true, recommendationId };
}