import { describe, expect, it } from "vitest";

import { canonicalJson, sha256, sha256Bytes } from "../src/shared/canonical.ts";

describe("canonicalJson", () => {
  it("serializes identically regardless of object key order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] });
    const b = canonicalJson({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("orders array elements without sorting them", () => {
    expect(canonicalJson([2, 1, 3])).toBe(JSON.stringify([2, 1, 3]));
  });

  it("handles primitives", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(5)).toBe("5");
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("sha256", () => {
  it("produces the same digest for semantically equal objects", () => {
    expect(sha256({ a: 1, b: 2 })).toBe(sha256({ b: 2, a: 1 }));
  });

  it("produces a 64-char hex digest", () => {
    expect(sha256({})).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when content differs", () => {
    expect(sha256({ a: 1 })).not.toBe(sha256({ a: 2 }));
  });
});

describe("sha256Bytes", () => {
  it("hashes raw bytes (SHA-256 of the ASCII string 'hello')", () => {
    const digest = sha256Bytes(new TextEncoder().encode("hello"));
    expect(digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashes a bare ArrayBuffer without throwing", () => {
    const bytes = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    expect(sha256Bytes(bytes)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("differs from hashing the canonical JSON string of the same content", () => {
    // sha256() hashes the canonical JSON encoding ("hello"); sha256Bytes hashes
    // the raw UTF-8 bytes. They are intentionally different encodings.
    expect(sha256Bytes(new TextEncoder().encode("hello"))).not.toBe(sha256("hello"));
  });
});