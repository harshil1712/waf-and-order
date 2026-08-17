/**
 * Test helpers for the guarded WAF apply path: a stateful fake Rulesets client
 * (GET ruleset, single-rule POST) and a fake durable `step` surface.
 */

import type {
  Ruleset,
  RulesetsClient,
} from "../../src/cloudflare/rulesets.ts";
import type { RulesetRule } from "../../src/cloudflare/rulesets.ts";

/** A stateful in-memory ruleset that preserves unrelated rules. */
export class FakeRulesets implements RulesetsClient {
  rules: RulesetRule[] = [];
  /** Call log for asserting the mutation shape and that only single-rule POSTs occur. */
  posts: { rule: unknown }[] = [];
  /** Call log for single-rule DELETEs (guarded rollback). */
  deletes: { ruleId: string }[] = [];
  /** If set, the created rule gets this id (deterministic). */
  nextRuleId: string | undefined;
  /** If set, the next DELETE fails with this message (to inject failures). */
  deleteFailures = 0;

  getRuleset(zoneId: string, rulesetId: string): Promise<Ruleset> {
    return Promise.resolve({
      id: rulesetId,
      name: "Block scanner traffic",
      phase: "http_request_firewall_custom",
      version: "2",
      rules: [...this.rules],
    });
  }

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
  ): Promise<Ruleset> {
    this.posts.push({ rule });
    const id = this.nextRuleId ?? `cf-rule-${this.rules.length + 1}`;
    const newRule: RulesetRule = {
      id,
      ref: rule.ref,
      expression: rule.expression,
      action: rule.action,
      description: rule.description,
      action_parameters: rule.action_parameters,
      enabled: true,
    };
    this.rules = [...this.rules, newRule];
    return Promise.resolve({
      id: rulesetId,
      name: "Block scanner traffic",
      phase: "http_request_firewall_custom",
      version: "2",
      rules: [...this.rules],
    });
  }

  deleteRule(zoneId: string, rulesetId: string, ruleId: string): Promise<Ruleset> {
    this.deletes.push({ ruleId });
    if (this.deleteFailures > 0) {
      this.deleteFailures--;
      throw new Error(`DELETE rule failed: ${ruleId}`);
    }
    this.rules = this.rules.filter((r) => r.id !== ruleId);
    return Promise.resolve({
      id: rulesetId,
      name: "Block scanner traffic",
      phase: "http_request_firewall_custom",
      version: "2",
      rules: [...this.rules],
    });
  }
}

/**
 * A fake durable `step` surface mirroring Flue 2.0.3 semantics: each step name
 * runs `fn` once and records its value; a re-execution of the same name returns
 * the recorded value without re-running `fn`. `calls` records which fns ran.
 */
export function fakeStep() {
  const recorded = new Map<string, unknown>();
  const calls: string[] = [];
  return {
    async do<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      if (recorded.has(name)) return recorded.get(name) as T;
      calls.push(name);
      const value = await fn();
      recorded.set(name, value);
      return value;
    },
    calls,
    recorded,
  };
}

/** A minimal tool context with the durable `step` surface for tests. */
export function durableContext(data: unknown, step: ReturnType<typeof fakeStep>) {
  return {
    toolCallId: "call-apply",
    signal: undefined,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    data,
    step,
  } as never;
}
