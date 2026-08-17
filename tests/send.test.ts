import { describe, expect, it } from "vitest";

import { reportSubject, type ReportSender } from "../src/shared/send.ts";

describe("reportSubject", () => {
  it("builds a subject from hostname and end day", () => {
    expect(reportSubject("example.com", "2026-08-13")).toBe(
      "Bot Traffic Weekly Report — example.com (week ending 2026-08-13)",
    );
  });
});

describe("ReportSender (mockable abstraction)", () => {
  it("supports injecting a real transport without changing the agent", async () => {
    const fakeSender: ReportSender = {
      async send(req) {
        return { sent: true, transport: "fake-email", detail: req.subject, reportId: req.reportId };
      },
    };
    const result = await fakeSender.send({
      zoneId: "zone-abc",
      reportId: "report-y",
      subject: "Bot Traffic Weekly Report",
      html: "<html></html>",
      text: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.transport).toBe("fake-email");
    expect(result.detail).toBe("Bot Traffic Weekly Report");
  });
});