/**
 * Cloudflare Access JWT enforcement for operator/control-plane routes.
 *
 * Follows the official Cloudflare pattern: verify the `Cf-Access-Jwt-Assertion`
 * header against the team domain's remote JWKS (`createRemoteJWKSet`) and the
 * app's `POLICY_AUD` audience, requiring the Access issuer (`TEAM_DOMAIN`).
 *
 * SECURITY (fails closed):
 *   - When `TEAM_DOMAIN` or `POLICY_AUD` is unset → reject (403).
 *   - When the header/token is absent → reject (403).
 *   - When `jwtVerify` fails (bad signature, wrong issuer/audience, expired,
 *     forged, unknown key) → reject (403).
 *
 * The JWKS set is cached at MODULE SCOPE per team domain so repeated calls in a
 * warm isolate do not refetch keys on every request. `jwtVerify` and
 * `createRemoteJWKSet` are injectable so tests can use local keys.
 */

import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** Config read from env at request time (non-secret). */
export interface AccessConfig {
  /** e.g. `https://<your-team>.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application AUD tag. */
  policyAud: string;
}

/** The identity of a verified operator (from the Access JWT payload). */
export interface VerifiedOperator {
  /** The Access user's email (payload.email), if present. */
  email?: string;
  /** The full verified payload (non-secret claims). */
  payload: Record<string, unknown>;
}

/** A signature-compatible subset of `jose`'s `jwtVerify` (raw, unbound). */
export interface JwtVerifier {
  (
    token: string,
    jwks: unknown,
    options: { issuer: string; audience: string },
  ): Promise<{ payload: Record<string, unknown> }>;
}

/** A verifier already bound to a team's JWKS (2-arg, ready for jwtVerify). */
interface BoundJwtVerifier {
  (
    token: string,
    options: { issuer: string; audience: string },
  ): Promise<{ payload: Record<string, unknown> }>;
}

/** A signature-compatible subset of `jose`'s `createRemoteJWKSet`. */
export type JwksFactory = (url: URL) => unknown;

/** Default jose-backed implementations (injectable in tests). */
const defaultJwtVerify: JwtVerifier = jwtVerify as unknown as JwtVerifier;
const defaultCreateRemoteJWKSet: JwksFactory =
  createRemoteJWKSet as unknown as JwksFactory;

/** Module-scope caches, keyed by team domain (safe in a warm isolate). */
const jwksCache = new Map<string, unknown>();
const verifierCache = new Map<string, BoundJwtVerifier>();

/** Reset the module-scope caches (test helper). */
export function resetAccessCaches(): void {
  jwksCache.clear();
  verifierCache.clear();
}

/**
 * Build (and cache) a per-team-domain verifier. Cacheing is per team domain so
 * multiple Access apps sharing a team share one JWKS fetch.
 */
function accessVerifierFor(
  config: AccessConfig,
  opts: {
    jwtVerifyImpl?: JwtVerifier;
    createRemoteJWKSetImpl?: JwksFactory;
  } = {},
): BoundJwtVerifier {
  const verify = opts.jwtVerifyImpl ?? defaultJwtVerify;
  const createJwks = opts.createRemoteJWKSetImpl ?? defaultCreateRemoteJWKSet;

  let verifier = verifierCache.get(config.teamDomain);
  if (verifier) return verifier;

  let jwks = jwksCache.get(config.teamDomain);
  if (!jwks) {
    jwks = createJwks(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(config.teamDomain, jwks);
  }
  verifier = (token, options) =>
    verify(token, jwks, options);
  verifierCache.set(config.teamDomain, verifier);
  return verifier;
}

/** Whether the supplied config is complete enough to enforce Access. */
function isAccessConfigured(config: AccessConfig): boolean {
  return Boolean(config.teamDomain && config.policyAud);
}

/** Extract the Access JWT from a request (header, else the session cookie). */
function extractAccessJwt(c: Context): string | undefined {
  const fromHeader = c.req.header("Cf-Access-Jwt-Assertion");
  if (fromHeader) return fromHeader;
  const fromCookie = c.req.header("cookie");
  if (fromCookie) {
    const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(fromCookie);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Hono middleware enforcing Cloudflare Access on the wrapped routes. On
 * success it sets `c.set("operator", verified)` for downstream handlers. On any
 * failure it returns a 403 and never calls `next()`.
 */
export function accessMiddleware(
  config: AccessConfig,
  opts: {
    jwtVerifyImpl?: JwtVerifier;
    createRemoteJWKSetImpl?: JwksFactory;
  } = {},
) {
  return async function enforceAccess(c: Context, next: Next): Promise<Response | void> {
    if (!isAccessConfigured(config)) {
      return c.json({ error: "access_not_configured" }, 403);
    }
    const token = extractAccessJwt(c);
    if (!token) {
      return c.json({ error: "missing_access_jwt" }, 403);
    }
    const verifier = accessVerifierFor(config, opts);
    try {
      const { payload } = await verifier(token, {
        issuer: config.teamDomain,
        audience: config.policyAud,
      });
      const operator: VerifiedOperator = {
        email: typeof payload.email === "string" ? payload.email : undefined,
        payload,
      };
      (c as Context<{ Variables: Record<string, unknown> }>).set("operator", operator);
      await next();
    } catch {
      return c.json({ error: "invalid_access_jwt" }, 403);
    }
  };
}