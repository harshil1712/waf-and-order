import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleInboundEmail } from "../src/email/handler.ts";
import { signToken, TOKEN_VERSION } from "../src/shared/approval-token.ts";
import { ZoneRegistryRepository } from "../src/registry/d1.ts";
import { CONTROL_PLANE_CONVERSATION_ID } from "../src/shared/control-plane.ts";
import { FakeD1, zoneRowForTest } from "./helpers/fake-d1.ts";

const SECRET = "s3cr3t-secret";
const ZONE_A = "zone-a";
const REC_ID = "R-1042";
const DOMAIN = "security.example.com";
const ALLOWED = ["approver@example.com"];

const NOW = new Date("2026-08-15T00:00:00Z");
const EXPIRES = "2026-08-20T00:00:00Z";

function useFixedApprovalTime() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

function tokenPayload(zoneId: string) {
  return {
    version: TOKEN_VERSION,
    tokenId: "tok-1",
    zoneId,
    recommendationId: REC_ID,
    decision: "APPLY" as const,
    expiresAt: EXPIRES,
  };
}

function fakeMessage(to: string, body: string, from = "approver@example.com") {
  // A minimal MIME message so the real postal-mime parser finds the body.
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    "Subject: re",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(raw));
      controller.close();
    },
  });
  const rejects: string[] = [];
  return {
    to,
    from,
    raw: stream as unknown as BodyInit,
    headers: new Headers(),
    setReject: (reason: string) => rejects.push(reason),
    rejects,
  } as unknown as ForwardableEmailMessage & { rejects: string[] };
}

function envStub(): CloudflareBindings {
  return {} as CloudflareBindings;
}

async function dispatchTarget() {
  const dispatchFn = vi.fn(async (_request: unknown) => {});
  return dispatchFn;
}

describe("inbound email zone binding (no global target zone)", () => {
  beforeEach(() => {
    useFixedApprovalTime();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.APPROVAL_TOKEN_SECRET;
  });

  it("dispatches to the shared control-plane conversation with the token's zoneId", async () => {
    process.env.APPROVAL_TOKEN_SECRET = SECRET;
    const db = new FakeD1([
      {
        ...zoneRowForTest(ZONE_A, "a.example.com"),
        allowed_envelope_senders: ALLOWED.join(","),
      },
    ]);
    const registry = new ZoneRegistryRepository(db);
    const dispatchFn = await dispatchTarget();
    const token = await signToken(tokenPayload(ZONE_A), SECRET);
    const msg = fakeMessage(`approve+${token}@${DOMAIN}`, `APPLY ${REC_ID}`);

    await handleInboundEmail(msg, envStub(), { registry, dispatchFn });

    expect(msg.rejects).toEqual([]);
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    const request = dispatchFn.mock.calls[0][0] as Record<string, unknown>;
    expect(request.id).toBe(CONTROL_PLANE_CONVERSATION_ID);
    const message = request.message as { type: string; attributes: Record<string, string> };
    expect(message.type).toBe("waf.recommendation.approved");
    expect(message.attributes).toMatchObject({
      zoneId: ZONE_A,
      recommendationId: REC_ID,
      approvalTokenId: "tok-1",
    });
    // No global TARGET zone: the zone came from the token + D1, not an env var.
    expect(request.id).not.toMatch(/^zone:/);
  });

  it("rejects a token bound to a zone not in the D1 registry", async () => {
    process.env.APPROVAL_TOKEN_SECRET = SECRET;
    const db = new FakeD1([zoneRowForTest("zone-other", "other.example.com")]);
    const registry = new ZoneRegistryRepository(db);
    const dispatchFn = await dispatchTarget();
    const token = await signToken(tokenPayload("zone-missing"), SECRET);
    const msg = fakeMessage(`approve+${token}@${DOMAIN}`, `APPLY ${REC_ID}`);

    await handleInboundEmail(msg, envStub(), { registry, dispatchFn });

    expect(msg.rejects[0]).toBe("unknown_or_disabled_zone");
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("rejects a token bound to a disabled zone", async () => {
    process.env.APPROVAL_TOKEN_SECRET = SECRET;
    const db = new FakeD1([
      { ...zoneRowForTest(ZONE_A, "a.example.com"), enabled: 0 },
    ]);
    const registry = new ZoneRegistryRepository(db);
    const dispatchFn = await dispatchTarget();
    const token = await signToken(tokenPayload(ZONE_A), SECRET);
    const msg = fakeMessage(`approve+${token}@${DOMAIN}`, `APPLY ${REC_ID}`);

    await handleInboundEmail(msg, envStub(), { registry, dispatchFn });

    expect(msg.rejects[0]).toBe("unknown_or_disabled_zone");
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("fails closed when the signing secret is unset", async () => {
    delete process.env.APPROVAL_TOKEN_SECRET;
    const db = new FakeD1([zoneRowForTest(ZONE_A, "a.example.com")]);
    const registry = new ZoneRegistryRepository(db);
    const dispatchFn = await dispatchTarget();
    const token = await signToken(tokenPayload(ZONE_A), SECRET);
    const msg = fakeMessage(`approve+${token}@${DOMAIN}`, `APPLY ${REC_ID}`);

    await handleInboundEmail(msg, envStub(), { registry, dispatchFn });

    expect(msg.rejects[0]).toBe("approval verification is not configured");
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("rejects a sender not allowed by the D1 zone's allowlist", async () => {
    process.env.APPROVAL_TOKEN_SECRET = SECRET;
    const db = new FakeD1([
      { ...zoneRowForTest(ZONE_A, "a.example.com"), allowed_envelope_senders: ALLOWED.join(",") },
    ]);
    const registry = new ZoneRegistryRepository(db);
    const dispatchFn = await dispatchTarget();
    const token = await signToken(tokenPayload(ZONE_A), SECRET);
    const msg = fakeMessage(`approve+${token}@${DOMAIN}`, `APPLY ${REC_ID}`, "attacker@evil.example");

    await handleInboundEmail(msg, envStub(), { registry, dispatchFn });

    expect(msg.rejects[0]).toBe("unauthorized_sender");
    expect(dispatchFn).not.toHaveBeenCalled();
  });
});
