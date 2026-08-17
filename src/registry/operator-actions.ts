/**
 * Operator action audit record types.
 *
 * An append-only audit log of operator-originated actions (currently rollback
 * confirmations). Records carry identifiers and operator identity only — never
 * secrets, tokens, rule payloads, or WAF credentials.
 */

/** A new operator action to append to D1 before dispatch. */
export interface NewOperatorAction {
  zoneId: string;
  recommendationId: string;
  /** The action verb, e.g. `waf.rollback.authorized`. */
  action: string;
  /** Operator identity from the Access JWT (`payload.email`). */
  operatorIdentity: string;
  /** The exact confirmation phrase supplied (validated in the API). */
  confirmationPhrase: string;
  /** Non-secret JSON-able metadata (e.g. origin). Defaults to {}. */
  metadata?: Record<string, unknown>;
  /** ISO timestamp (usually injected for determinism in tests). */
  createdAt: string;
}

/** The exact confirmation phrase an operator must type to authorize rollback. */
export const ROLLBACK_CONFIRMATION_PHRASE = "I AUTHORIZE ROLLBACK";

/** Whether a supplied phrase matches the required confirmation phrase. */
export function isRollbackConfirmation(phrase: string): boolean {
  return phrase.trim() === ROLLBACK_CONFIRMATION_PHRASE;
}
