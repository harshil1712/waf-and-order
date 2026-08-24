import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDailyCollection } from "../src/analytics/orchestration.ts";
import { FakeR2 } from "./helpers/fake-r2.ts";
import { cannedFetcher, HOSTNAME, ZONE_ID } from "./helpers/fixtures.ts";

const TOKEN = "test-read-token";

/** Mock fetch so queryGraphQL uses the canned fixture data and exposes headers. */
function mockGraphQLFetch() {
  const fetcher = cannedFetcher();
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const response = await fetcher(body.query, body.variables);
    return new Response(JSON.stringify(response), { status: 200 });
  });
}

describe("runDailyCollection shared read-token usage", () => {
  beforeEach(() => {
    process.env.CLOUDFLARE_READ_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_READ_TOKEN;
    vi.restoreAllMocks();
  });

  it("throws when CLOUDFLARE_READ_TOKEN is unset", async () => {
    delete process.env.CLOUDFLARE_READ_TOKEN;
    const bucket = new FakeR2();
    await expect(
      runDailyCollection({ BOT_TRAFFIC_ANALYTICS: bucket }, { zoneId: ZONE_ID, hostname: HOSTNAME } as never),
    ).rejects.toThrow("CLOUDFLARE_READ_TOKEN is not set; cannot collect analytics.");
  });

  it("uses CLOUDFLARE_READ_TOKEN as the GraphQL Authorization bearer", async () => {
    const fixedNow = Date.parse("2026-08-15T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    const bucket = new FakeR2();
    const fetchMock = mockGraphQLFetch();
    vi.stubGlobal("fetch", fetchMock);

    await runDailyCollection(
      { BOT_TRAFFIC_ANALYTICS: bucket },
      { zoneId: ZONE_ID, hostname: HOSTNAME } as never,
    );

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls;
    const authorizedCalls = calls.filter(([, init]) => {
      const headers = new Headers(init?.headers);
      return headers.get("authorization") === `Bearer ${TOKEN}`;
    });
    expect(authorizedCalls.length).toBeGreaterThan(0);

    // Every GraphQL request must carry the shared read-only token.
    const graphqlCalls = calls.filter(([input]) =>
      String(input).startsWith("https://api.cloudflare.com/client/v4/graphql"),
    );
    for (const [, init] of graphqlCalls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
  });
});
