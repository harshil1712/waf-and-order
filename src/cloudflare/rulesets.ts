/**
 * Application-owned Cloudflare Rulesets client.
 *
 * This is the ONLY component that talks to the Rulesets write API, and it uses
 * the separate `WAF_WRITE_TOKEN` secret — never the read-only MCP credential.
 * It deliberately exposes a narrow surface:
 *
 *   - GET a zone ruleset (read-before-write recovery / verification)
 *   - POST a SINGLE rule to a zone ruleset (never a whole-ruleset PUT)
 *   - DELETE a SINGLE rule by id (never a whole-ruleset PUT)
 *
 * We never PUT a full rules list, so unrelated rules cannot be dropped by
 * submitting an incomplete list, and version drift is never a prerequisite for
 * applying. The rule payload is built by deterministic tool code from trusted
 * persistent state, never from the model.
 *
 * Tests inject a fake fetch / client; this module performs no live WAF writes.
 */

/** A single ruleset rule as returned by the API. */
export interface RulesetRule {
  id: string;
  ref?: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  description?: string;
  enabled?: boolean;
}

/** A zone ruleset as returned by the API. */
export interface Ruleset {
  id: string;
  name: string;
  phase: string;
  version: string;
  rules: RulesetRule[];
}

/** The narrow write/read surface used by the apply tool. */
export interface RulesetsClient {
  /** GET /zones/{zone}/rulesets/{ruleset} */
  getRuleset(zoneId: string, rulesetId: string): Promise<Ruleset>;
  /**
   * POST /zones/{zone}/rulesets/{ruleset}/rules — submit exactly one new rule.
   * Returns the updated ruleset, from which the caller extracts the created
   * rule's id and reference.
   */
  createRule(
    zoneId: string,
    rulesetId: string,
    rule: {
      expression: string;
      action: "managed_challenge";
      description: string;
      ref: string;
      action_parameters: Record<string, string>;
    },
  ): Promise<Ruleset>;
  /**
   * DELETE /zones/{zone}/rulesets/{ruleset}/rules/{rule_id} — remove exactly
   * one rule by id. Returns the updated ruleset. Never PUTs a whole rules list,
   * so unrelated/intervening rules are preserved. Used only by the guarded
   * rollback service.
   */
  deleteRule(zoneId: string, rulesetId: string, ruleId: string): Promise<Ruleset>;
}

/** An error from the Rulesets API. */
export class RulesetsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: unknown,
  ) {
    super(message);
    this.name = "RulesetsApiError";
  }
}

/** A narrow `fetch`-like surface so tests can inject a fake without `as` casts. */
export interface FetchLike {
  (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Build the application-owned client bound to the WAF write token. */
export function createRulesetsClient(
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): RulesetsClient {
  const auth = { Authorization: `Bearer ${token}` };
  if (!token) {
    throw new RulesetsApiError("WAF write token is not configured; refusing to write.", 401, null);
  }

  async function getRuleset(zoneId: string, rulesetId: string): Promise<Ruleset> {
    const res = await fetchImpl(`${API_BASE}/zones/${zoneId}/rulesets/${rulesetId}`, {
      headers: auth,
    });
    const body = (await res.json()) as { success: boolean; errors: unknown; result?: Ruleset };
    if (!res.ok || !body.success || !body.result) {
      throw new RulesetsApiError(`GET ruleset failed`, res.status, body.errors);
    }
    return body.result;
  }

  async function createRule(
    zoneId: string,
    rulesetId: string,
    rule: Parameters<RulesetsClient["createRule"]>[2],
  ): Promise<Ruleset> {
    const res = await fetchImpl(`${API_BASE}/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(rule),
    });
    const body = (await res.json()) as { success: boolean; errors: unknown; result?: Ruleset };
    if (!res.ok || !body.success || !body.result) {
      throw new RulesetsApiError(`POST rule failed`, res.status, body.errors);
    }
    return body.result;
  }

  async function deleteRule(
    zoneId: string,
    rulesetId: string,
    ruleId: string,
  ): Promise<Ruleset> {
    const res = await fetchImpl(`${API_BASE}/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
      method: "DELETE",
      headers: auth,
    });
    const body = (await res.json()) as { success: boolean; errors: unknown; result?: Ruleset };
    if (!res.ok || !body.success || !body.result) {
      throw new RulesetsApiError(`DELETE rule failed`, res.status, body.errors);
    }
    return body.result;
  }

  return { getRuleset, createRule, deleteRule };
}