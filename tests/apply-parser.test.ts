import { describe, expect, it } from "vitest";

import {
  firstMeaningfulLine,
  isMeaningfulLine,
  parseApplyCommand,
} from "../src/shared/apply-parser.ts";

describe("firstMeaningfulLine", () => {
  it("returns the first non-empty, non-quoted line", () => {
    expect(firstMeaningfulLine("\n\nAPPLY R-1042\n")).toBe("APPLY R-1042");
  });

  it("skips quoted lines and signatures", () => {
    const body = `> On Tue, Aug 13, 2026 at 12:00 AM you wrote:
> APPLY R-9999

APPLY R-1042

--
Signature`;
    expect(firstMeaningfulLine(body)).toBe("APPLY R-1042");
  });

  it("returns undefined for an empty or all-quoted body", () => {
    expect(firstMeaningfulLine("")).toBeUndefined();
    expect(firstMeaningfulLine("\n\n\n")).toBeUndefined();
    expect(firstMeaningfulLine("> quoted only\n> still quoted")).toBeUndefined();
  });
});

describe("isMeaningfulLine", () => {
  it("treats quotes, blanks, and signature boundaries as not meaningful", () => {
    expect(isMeaningfulLine("> quoted")).toBe(false);
    expect(isMeaningfulLine("")).toBe(false);
    expect(isMeaningfulLine("   ")).toBe(false);
    expect(isMeaningfulLine("--")).toBe(false);
    expect(isMeaningfulLine("-- John")).toBe(false);
  });
  it("treats a plain command line as meaningful", () => {
    expect(isMeaningfulLine("APPLY R-1042")).toBe(true);
  });
});

describe("parseApplyCommand (exact)", () => {
  it("parses an exact APPLY <id>", () => {
    expect(parseApplyCommand("APPLY R-1042")).toEqual({
      ok: true,
      recommendationId: "R-1042",
    });
  });

  it("accepts lowercase keyword but exact id", () => {
    expect(parseApplyCommand("apply R-1042")).toEqual({
      ok: true,
      recommendationId: "R-1042",
    });
  });

  it("ignores everything after the first meaningful line (quoted/forwarded)", () => {
    const body = `> On Tue you wrote:
> APPLY R-9999

APPLY R-1042

On Wed, forwarded from X:
APPLY R-8888`;
    const parsed = parseApplyCommand(body);
    expect(parsed.ok).toBe(true);
    expect(parsed.recommendationId).toBe("R-1042");
  });

  it("rejects a quoted APPLY as the only content", () => {
    const parsed = parseApplyCommand("> APPLY R-1042\n> I replied earlier");
    expect(parsed.ok).toBe(false);
  });

  it("rejects APPLY ALL", () => {
    expect(parseApplyCommand("APPLY ALL")).toEqual({
      ok: false,
      reason: "not_an_apply_command",
    });
  });

  it("rejects trailing words after the id", () => {
    expect(parseApplyCommand("APPLY R-1042 please")).toEqual({
      ok: false,
      reason: "not_an_apply_command",
    });
  });

  it("rejects an invalid recommendation id", () => {
    expect(parseApplyCommand("APPLY 1042")).toEqual({
      ok: false,
      reason: "not_an_apply_command",
    });
    expect(parseApplyCommand("APPLY R-ABC")).toEqual({
      ok: false,
      reason: "not_an_apply_command",
    });
  });

  it("rejects a command in an attachment-ish first line", () => {
    expect(parseApplyCommand("Please APPLY R-1042")).toEqual({
      ok: false,
      reason: "not_an_apply_command",
    });
  });

  it("rejects an empty reply", () => {
    expect(parseApplyCommand("")).toEqual({ ok: false, reason: "empty_reply" });
    expect(parseApplyCommand("> quoted\n> more")).toEqual({ ok: false, reason: "empty_reply" });
  });
});