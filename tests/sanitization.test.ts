import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  MAX_TRAFFIC_STRING_LENGTH,
  sanitizeDimensionValue,
  truncateTrafficString,
} from "../src/analytics/sanitization.ts";

describe("escapeHtml", () => {
  it("escapes markup, quotes, and ampersands", () => {
    expect(escapeHtml(`<script>"a"&'b'</script>`)).toBe(
      "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;",
    );
  });

  it("leaves safe strings untouched", () => {
    expect(escapeHtml("plain path /about")).toBe("plain path /about");
  });
});

describe("truncateTrafficString", () => {
  it("keeps short strings unchanged", () => {
    expect(truncateTrafficString("short")).toBe("short");
  });

  it("truncates long strings to the max length with a suffix", () => {
    const long = "x".repeat(MAX_TRAFFIC_STRING_LENGTH + 100);
    const result = truncateTrafficString(long);
    expect(result.length).toBe(MAX_TRAFFIC_STRING_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("sanitizeDimensionValue", () => {
  it("truncates string values", () => {
    const value = "a".repeat(MAX_TRAFFIC_STRING_LENGTH + 50);
    expect((sanitizeDimensionValue("path", value) as string).length).toBe(MAX_TRAFFIC_STRING_LENGTH);
  });

  it("passes booleans, numbers, and null through", () => {
    expect(sanitizeDimensionValue("verifiedBotCategory", true)).toBe(true);
    expect(sanitizeDimensionValue("status", 200)).toBe(200);
    expect(sanitizeDimensionValue("path", null)).toBe(null);
  });
});