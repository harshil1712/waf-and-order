import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";

import {
  accessMiddleware,
  resetAccessCaches,
} from "../src/access/jwks.ts";

const TEAM = "https://my-team.cloudflareaccess.com";
const AUD = "aud-123";

async function buildKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  return { publicKey, privateKey, publicJwk };
}

/** Build a JWT with the given claims, signed by a given key. */
async function sign(
  privateKey: CryptoKey,
  opts: { issuer?: string; audience?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT({ email: "operator@example.com" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? TEAM)
    .setAudience(opts.audience ?? AUD)
    .setExpirationTime(opts.exp ?? "2h")
    .setIssuedAt()
    .sign(privateKey);
}

/** A minimal protected app using the middleware with injected local JWKS. */
function buildApp(privateOpts?: {
  jwtVerifyImpl?: (token: string, jwks: unknown, options: { issuer: string; audience: string }) => Promise<{ payload: Record<string, unknown> }>;
  createRemoteJWKSetImpl?: (url: URL) => unknown;
  teamDomain?: string;
  policyAud?: string;
}) {
  const opts = privateOpts ?? {};
  const app = new Hono();
  app.use(
    "/protected/*",
    accessMiddleware(
      {
        teamDomain: opts.teamDomain ?? TEAM,
        policyAud: opts.policyAud ?? AUD,
      },
      {
        jwtVerifyImpl: opts.jwtVerifyImpl,
        createRemoteJWKSetImpl: opts.createRemoteJWKSetImpl,
      },
    ),
  );
  app.get("/protected", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

async function localOpts(publicJwk: Record<string, unknown>) {
  return {
    jwtVerifyImpl: (token: string, jwks: unknown, options: { issuer: string; audience: string }) =>
      jwtVerify(token, jwks as Parameters<typeof jwtVerify>[1], options),
    // Return a single JWK (not a JWKSet) so jose verifies without kid matching.
    createRemoteJWKSetImpl: () => publicJwk,
  };
}

describe("Cloudflare Access JWT enforcement", () => {
  beforeEach(() => resetAccessCaches());

  it("accepts a valid Access JWT", async () => {
    const { publicKey, privateKey, publicJwk } = await buildKeys();
    const token = await sign(privateKey);
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a request with no Access JWT header", async () => {
    const { publicJwk } = await buildKeys();
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected");
    expect(res.status).toBe(403);
  });

  it("rejects a forged JWT signed by a key not in the JWKS", async () => {
    const { publicJwk } = await buildKeys();
    const { privateKey: attackerKey } = await buildKeys();
    const forged = await sign(attackerKey);
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": forged },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a JWT with the wrong audience", async () => {
    const { privateKey, publicJwk } = await buildKeys();
    const token = await sign(privateKey, { audience: "other-aud" });
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a JWT with the wrong issuer", async () => {
    const { privateKey, publicJwk } = await buildKeys();
    const token = await sign(privateKey, { issuer: "https://evil.example" });
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired JWT", async () => {
    const { privateKey, publicJwk } = await buildKeys();
    const token = await sign(privateKey, { exp: "1s" });
    await new Promise((r) => setTimeout(r, 1100));
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(403);
  });

  it("fails closed when Access config is missing", async () => {
    const { privateKey, publicJwk } = await buildKeys();
    const token = await sign(privateKey);
    const app = buildApp({
      ...(await localOpts(publicJwk)),
      teamDomain: "",
      policyAud: "",
    });
    const res = await app.request("/protected", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access_not_configured" });
  });

  it("leaves /health open (not behind the middleware)", async () => {
    const { publicJwk } = await buildKeys();
    const app = buildApp(await localOpts(publicJwk));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});