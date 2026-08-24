# WAF and Order

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/harshil1712/waf-and-order)

WAF and Order is a multi-zone bot-traffic analyst for a single Cloudflare
account. It collects daily GraphQL analytics into zone-keyed R2 rollups, sends
weekly email reports and signed single-use email approvals, applies only bounded
Managed Challenge rules through a deterministic application-owned Rulesets
client, monitors 24h and 7d full-day outcomes, and exposes Access-protected
operator rollback.

One Worker hosts every entrypoint. One shared control-plane Flue agent and
conversation owns all zone state. D1 holds the zone registry and operator audit
log; R2 holds analytics. State is keyed by `zoneId`, but the MVP does not offer
tenant isolation: every zone in the account shares the single conversation, the
single Access app, and one account-wide `WAF_WRITE_TOKEN`.

## Prerequisites

- **Node.js 22+** (see `.nvmrc` and the package `engines` declaration)
- **npm**
- A **Cloudflare account** with access to: **Workers** (deployment),
  **D1** (zone registry), **R2** (analytics rollups), **Workers AI** (agent
  model), **Durable Objects** (control-plane agent state), **Cron Triggers**
  (scheduled collection), **Cloudflare Access** (protects operator/agent
  routes), **Email Routing and Email Sending** (approval replies and weekly
  reports), and **GraphQL Analytics** (traffic collection).
- A **Workers Paid plan** or prepaid **AI Gateway credits** for the default
  `@cf/moonshotai/kimi-k2.6` model. To deploy on Workers Free, replace the
  `useModel` value in `src/agents/zone-bot-analyst.ts` with
  `cloudflare/@cf/zai-org/glm-4.7-flash`, which is available on the Free plan.

## Deploy

### Deploy to Cloudflare (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/harshil1712/waf-and-order)

The button clones this repository into your GitHub account, configures Workers
Builds, provisions the declared D1 database, R2 bucket, Workers AI binding and
Durable Object, applies the D1 migrations, and deploys the Worker.

After the deployment completes:

1. Complete the [external onboarding](#external-onboarding) for Cloudflare
   Access and email.
2. Add the required [secrets](#secrets). Leave `WAF_WRITE_TOKEN` unset for an
   initial read-only rollout.
3. [Register at least one zone in D1](#zones-in-d1).
4. Open `/health` on the deployed Worker to verify it is running.

### First-time manual setup (clean account)

From a clone of this repository:

```sh
npm ci
npx wrangler login
npm run setup
```

`npm run setup` is `npm run build && wrangler deploy --minify && npm run
db:migrations:apply`. The first `wrangler deploy` auto-provisions the D1
database and R2 bucket declared in `wrangler.jsonc` (they are referenced by
name without resource IDs, so Wrangler creates and links them), then migrations
are applied to the provisioned database. On an interactive deploy, Wrangler may
offer to write the provisioned resource IDs back into `wrangler.jsonc`.

### Subsequent deploys

```sh
npm run deploy
```

`npm run deploy` is `npm run db:migrations:apply && vite build && wrangler
deploy --minify`: it applies any new D1 migrations by binding name (`DB`),
rebuilds, and deploys.

### External onboarding

Two external steps are not covered by any deploy flow:

- **Cloudflare Access** protects `/agents/*` and `/operator/*`. Create an Access
  application for the Worker routes, then set `TEAM_DOMAIN` and `POLICY_AUD`.
  These routes fail closed until both are set; `/health` stays open.
- **Email Routing and Email Sending** are external onboarding. Inbound approval
  requires a catch-all or plus-address routing rule to the Worker `email()`
  handler for each registered zone's report domain (the approval `Reply-To` is
  `approve+<token>@<domain>`). Outbound weekly reports require a verified Email
  Sending sender and recipient.

For an initial **read-only rollout**, omit `WAF_WRITE_TOKEN`. The apply tool is
not mounted and rollback fails closed, so nothing can write to a ruleset until
you deliberately provision that secret.

## Configuration

Secrets are set with `npx wrangler secret put <NAME>` and never committed. Vars
are non-secret values in `wrangler.jsonc` (or `.dev.vars` for local dev).

### Vars

| Var | Required | Fails closed when | Notes |
|---|---|---|---|
| `TEAM_DOMAIN` | No | Empty: Access-protected routes reject all requests | Access team domain, e.g. `https://<your-team>.cloudflareaccess.com` |
| `POLICY_AUD` | No | Empty: Access-protected routes reject all requests | Access application AUD tag |
| `OPERATOR_ALLOWED_ORIGINS` | No | Empty: browser POST `Origin` must be same-origin with the request URL | Comma-separated allowed origins for operator POSTs; empty enforces same-origin, it does not disable enforcement |

### Secrets

| Secret | Required | Fails closed when | Notes |
|---|---|---|---|
| `CLOUDFLARE_ANALYTICS_TOKEN` | Yes for collection | Absent: daily collection errors | Read-only token with GraphQL Analytics access |
| `APPROVAL_TOKEN_SECRET` | Yes for approvals | Absent: token signing and verification fail | Long random secret, e.g. `openssl rand -hex 32`; signs single-use approval tokens |
| `WAF_WRITE_TOKEN` | No | Absent: apply tool not mounted, rollback fails closed | Account-wide write token used only by the application-owned Rulesets client; omit for read-only rollout |
| `CLOUDFLARE_MCP_TOKEN` | No | Absent: model-facing MCP connection unavailable | Read-only Cloudflare token for the model-facing connection |
| `AGENT_ACCESS_TOKEN` | No | Absent: bearer check skipped | Defense-in-depth bearer on the agent route behind Access |

Secrets are never stored in D1.

#### Cloudflare MCP token permissions

`CLOUDFLARE_MCP_TOKEN` is optional. It is a Cloudflare API token used as a
bearer token for unattended access to `https://mcp.cloudflare.com/mcp`; the
Worker does not run the interactive OAuth flow. The MCP connection exposes only
the `search` tool and does not mount `execute`. There is no MCP-specific API
token permission. For this application's read-only MCP access, create a custom
token with:

- **Zone > Zone > Read**
- **Zone > Zone WAF > Read**

Restrict the token's resources to only the account and zones registered in this
application. Add **Zone > Analytics > Read** only if you also want the MCP
connection to search analytics capabilities; scheduled collection uses the
separate `CLOUDFLARE_ANALYTICS_TOKEN`. Do not grant write permissions.

## Architecture

Three resources bind into the Worker: the `DB` D1 database (zone registry and
operator audit log), the `BOT_TRAFFIC_ANALYTICS` R2 bucket (zone-keyed rollups
and monitoring outcomes), and the `EMAIL` `send_email` binding, alongside the
`AI` Workers AI binding for the agent model.

Three Cron Triggers drive the pipeline:

- `0 4 * * *` daily GraphQL collection of the previous completed day plus
  bounded gap backfill
- `0 5 * * 1` weekly report signal (Monday)
- `0 6 * * *` monitoring check after daily collection

Each scheduled handler enumerates the enabled zones from D1 and dispatches a
per-zone signal to the shared `control-plane` conversation with a per-zone
idempotency key. Per-zone failures are isolated: one failing zone does not
starve the rest.

The daily collector queries GraphQL Analytics with a read-only token and writes
a plain JSON rollup to R2 per zone per day. Unsupported metrics (client ASN,
Bot Management decision, firewall events) are omitted, never estimated.

Approvals flow through email. The weekly report carries a plus-addressed
`Reply-To` of `approve+<token>@<domain>`. An approved sender replies `APPLY
R-<id>`. Inbound Email Routing invokes the `email()` handler, which resolves the
zone from the token plus D1, validates the signed single-use token, rejects
bounces, vacation and automated mail, and requires an exact `APPLY <id>`. The
shared agent transitions the recommendation in one atomic persisted-state
update; duplicate deliveries converge because the first valid transition wins.

The apply and rollback paths are deterministic and application-owned. Only
bounded, low or medium risk Managed Challenge recommendations are
email-approvable. The apply client re-validates every recommendation before
mutating Cloudflare, targets the D1-resolved zone, ruleset and phase, and writes
exactly one rule. Rollback is a single-rule DELETE with read-before-delete
resolution: a drifted rule aborts for operator review rather than falling back.

## Zones in D1

The registry starts **empty**: `migrations/0001_zone_registry.sql` creates the
tables but seeds no rows, so nothing is analyzed until you register a zone.
`zones` is the registry that cron dispatch, inbound email authorization and tool
config resolution read from. Each row is non-secret per-zone configuration:

`zone_id` (PK), `hostname`, `ruleset_id`, `ruleset_phase`,
`ruleset_version`, `enabled`, `allowed_envelope_senders`,
`report_sender`, `report_recipient`, `created_at`, `updated_at`.

`operator_actions` is an append-only audit log of operator rollback
confirmations: `id`, `zone_id`, `recommendation_id`, `action`,
`operator_identity`, `confirmation_phrase`, `metadata`, `created_at`.

Register a zone from the D1 console or `wrangler d1 execute` using non-secret
configuration:

```sql
INSERT INTO zones (
  zone_id, hostname, ruleset_id, ruleset_phase, ruleset_version,
  enabled, allowed_envelope_senders, report_sender, report_recipient,
  created_at, updated_at
) VALUES (
  '<ZONE_ID>', '<HOSTNAME>', '<CUSTOM_RULESET_ID>',
  'http_request_firewall_custom', '<RULESET_VERSION>', 1,
  '<APPROVER_EMAILS>', '<REPORT_FROM>', '<REPORT_TO>',
  datetime('now'), datetime('now')
);
```

Remove a zone (and its data):

```sql
DELETE FROM zones WHERE zone_id = '<ZONE_ID>';
```

No code change or redeploy is required. Secrets remain Worker secrets and are
never part of a row.

## Operator API

Access-protected routes for a separately authorized operator:

- `GET /operator/zones` lists enabled zones from D1.
- `POST /operator/rollback` requires `zoneId`, `recommendationId` and the exact
  confirmation phrase `I AUTHORIZE ROLLBACK`, validates the browser `Origin`,
  writes an append-only D1 audit row, then dispatches the
  `waf.rollback.authorized` signal to the shared agent. The agent runs the
  guarded single-rule DELETE and marks the recommendation `rolled_back` only
  after a confirmed `deleted` or `already_absent` result.
- `/agents/zone-bot-analyst/control-plane` exposes the shared control-plane
  agent conversation, behind Access.

There is no model-mounted rollback tool and no DELETE exposed through MCP; the
model can never trigger rollback.

## Safety boundaries

- Collection, reports, recommendations, apply and monitoring are deterministic
  code. The model supplies identifiers only; it never chooses a ruleset id,
  rule payload, expression, hostname or phase.
- Apply is bounded to a single rule with a conservative expression policy and a
  bounded blast radius. Only low and medium risk Managed Challenge
  recommendations are email-approvable.
- Rollback is operator-only and application-owned, with read-before-delete
  resolution and a follow-up verify.
- Every credential-gated path fails closed. Access-protected routes reject when
  `TEAM_DOMAIN` or `POLICY_AUD` is unset; sends throw when Email Sending is
  unprovisioned; apply and rollback fail closed without `WAF_WRITE_TOKEN`.
- No live WAF write, email send, D1 mutation or deployment is performed by
  tests. Email Sending is not onboarded and no live integration was tested.

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run cf-typegen
npm run dev
```

## Test

```sh
npm test
```

The suite is fully mocked: Email Sending adapter, inbound engine, D1 registry,
Access JWT validation, WAF client and guarded rollback are tested with fakes and
local keys. Unsupported or unprovisioned paths surface as errors rather than
silent no-ops.

## Verification

```sh
npm run check        # tsc --noEmit && vite build
```

## Known limitations

- No tenant isolation: all zones in the account share one conversation, one
  Access app and one `WAF_WRITE_TOKEN`. Per-zone tokens and per-zone
  conversations are the hardening path.
- One account-wide write token can, in principle, apply to any registered zone.
  It is bounded by the token's Cloudflare API scoping and the D1-resolved,
  zone-bound apply and rollback code paths.
- A long-running signal for one zone delays another in the single conversation.
- Unsupported metrics are reported unavailable, never estimated. In particular,
  challenge and firewall-event metrics cannot be collected on the current plan.

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE)

## Relevant Cloudflare docs

- [Workers](https://developers.cloudflare.com/workers/)
- [D1](https://developers.cloudflare.com/d1/)
- [R2](https://developers.cloudflare.com/r2/)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Email Routing](https://developers.cloudflare.com/email-routing/)
- [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
