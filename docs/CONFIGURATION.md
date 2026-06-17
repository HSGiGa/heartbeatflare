# Configuration

All platform configuration lives in `config.yaml`, validated by
[`config.schema.json`](../config.schema.json). The repo ships a ready-to-edit
[`config.example.yaml`](../config.example.yaml) — copy it to your own `config.yaml`, edit it, and
**commit it in your repo** (`cp config.example.yaml config.yaml`). Local dev and tests fall back to
the example when `config.yaml` is absent, but a **production deploy fails fast** without your own
`config.yaml`, so a forgotten copy can't ship the demo.

`config.yaml` is the single source of truth: the Worker never reads YAML at runtime — it is
imported into D1 by the `config:import` deploy step, and the Worker operates exclusively against D1.

Editing configuration is a git change: commit `config.yaml` and deploy (or push to `main`).
The import is idempotent — removing a monitor, channel or window soft-disables or deletes it
(see [Import semantics](#import-semantics)).

- [File overview](#file-overview)
- [`deploy`](#deploy)
- [`auth` (optional)](#auth-optional)
- [`notification_channels`](#notification_channels)
- [`monitors`](#monitors)
- [`alerts`](#alerts)
- [`maintenance`](#maintenance)
- [Public endpoints](#public-endpoints)
- [Secrets and `${VAR}` placeholders](#secrets-and-var-placeholders)
- [Import semantics](#import-semantics)
- [Full example](#full-example)

## File overview

```yaml
deploy:       # required — worker name, optional custom domain, resource name overrides
auth:         # optional — Cloudflare Access verification for the /private page
notification_channels:   # optional — where incident notifications are delivered
monitors:     # required — what to probe and the alert rules for each
maintenance:  # optional — planned-work windows that suppress probing + show a banner
```

Only `deploy` and `monitors` are required. Everything else is optional — in particular the
`auth` block: omit it and `/public` still deploys and serves normally (the `/private` page
simply shows the same public-only view until you configure Access).

## `deploy`

The single place to configure deployment. Resource names derive from `name` unless overridden;
no D1 or queue IDs are ever stored in the repo (they are resolved by name at deploy time into the
generated `wrangler.jsonc`).

```yaml
deploy:
  name: status                  # worker name; D1/queue names derive from it
  domain: status.example.com    # custom domain route; omit to serve on workers.dev only
  # database_name: ...          # default: ${name}-prod-db
  # queue_name: ...             # default: ${name}-notifications
```

| Field | Required | Description |
| --- | --- | --- |
| `name` | yes | Worker name. The D1 database (`${name}-prod-db`) and queue (`${name}-notifications`) derive from it. |
| `domain` | no | Custom domain route. Omit to serve only on `<name>.<subdomain>.workers.dev`. The zone must already exist in the Cloudflare account. |
| `database_name` | no | Override the derived D1 database name. |
| `queue_name` | no | Override the derived queue name. |
| `vpc` | no | Cloudflare Workers VPC bindings for `mode: internal` monitors. See [`deploy.vpc`](#deployvpc-internal-monitors). |

### `deploy.vpc` (internal monitors)

> **Beta.** [Cloudflare Workers VPC](https://developers.cloudflare.com/workers-vpc/) is in beta; its
> API/config may change. Verify the current Cloudflare docs before relying on it in production.

`mode: internal` monitors probe **private** targets through a Workers VPC binding instead of the
public internet. heartbeatflare only *consumes* pre-existing VPC resources by id/binding — it never
provisions Networks, Services, Tunnels, routes, CIDRs, or Zero Trust policies. Manage those through
the Cloudflare dashboard, Terraform, or a dedicated infrastructure repo.

```yaml
deploy:
  name: status
  vpc:
    networks:                      # tunnel-backed VPC Networks → generated as wrangler vpc_networks
      - binding: DEMO_NETWORK
        tunnel_id: ${DEMO_TUNNEL_ID}
        # remote: true             # default true; harmless for production deploys
    services:                      # scoped VPC Services → generated as wrangler vpc_services
      - binding: DEMO_SERVICE
        service_id: ${DEMO_VPC_SERVICE_ID}
```

- A monitor selects a binding by name via [`vpc_binding`](#internal-monitors-mode-internal).
- **Networks** give broad access to any target reachable through a Cloudflare Tunnel; the monitor's
  `target` host:port is the real private address. Cloudflare Mesh (`network_id: cf1:network`) is
  **not supported in v1** — tunnel-backed networks only (use `tunnel_id`).
- **Services** scope access to a single private host:port fixed by `service_id`. For a service the
  monitor's `target` host:port is **ignored** for routing (it only sets the HTTP `Host` / TLS SNI);
  only the path matters.
- **Network risk:** a tunnel-backed `vpc_networks` binding exposes the Worker to whatever the
  `cloudflared` connector can reach from its runtime environment. In Kubernetes, that can include
  other `*.svc.cluster.local` services, ClusterIP services in other namespaces, pod IPs, node/internal
  networks, kube-dns, and possibly the Kubernetes API unless egress is restricted. Prefer
  `vpc_services` for a fixed target. If you use `vpc_networks`, add Kubernetes NetworkPolicy or
  equivalent firewall rules around the `cloudflared` connector so it can reach only the intended
  private services plus required DNS/Cloudflare egress.
- Resource ids (`tunnel_id`, `service_id`) are account/environment specific — provide them via
  `.env` locally and CI env/secrets in deployment, referenced as `${VAR}` placeholders. Unlike
  `headers` (`PROBE_HEADERS`, resolved at probe runtime), VPC ids are substituted at
  **`wrangler.jsonc` generation time** because a binding needs a literal id at deploy time. Binding
  names are not secret and may stay in `config.yaml`. In local mode an unset `${VAR}` simply omits
  that binding (so dev/test never fail on absent infrastructure ids); a deploy fails fast.

| Field | Required | Description |
| --- | --- | --- |
| `networks[].binding` | yes | Worker binding name referenced by a monitor's `vpc_binding`. Unique across networks and services. |
| `networks[].tunnel_id` | yes | Cloudflare Tunnel UUID (or `${VAR}`). `network_id` / Mesh is unsupported in v1. |
| `networks[].remote` | no | Use the remote resource during local dev. Default `true`. |
| `services[].binding` | yes | Worker binding name referenced by a monitor's `vpc_binding`. Unique across networks and services. |
| `services[].service_id` | yes | VPC Service UUID (or `${VAR}`). |
| `services[].remote` | no | Use the remote resource during local dev. Default `true`. |

## `auth` (optional)

Enables Cloudflare Access JWT verification for the `/private` page. **This block is optional** —
without it, `/public` works and `/private` falls back to the public-only view.

```yaml
auth:
  provider: cloudflare_access
  team_name: "${CLOUDFLARE_ACCESS_TEAM_NAME}"
  aud: "${CLOUDFLARE_ACCESS_AUD}"
```

The Access application itself is created manually in the Cloudflare dashboard and **must be scoped
to the `/private` path** — see [Cloudflare Access for `/private`](DEPLOYMENT.md#cloudflare-access-for-private)
in the deployment guide. `team_name` and `aud` are `${VAR}` placeholders resolved from Worker
secrets at runtime (see [Secrets](#secrets-and-var-placeholders)).

## `notification_channels`

Where incident open / resolve / escalation messages are delivered. Three channel types are
implemented:

| `type` | Required fields | Notes |
| --- | --- | --- |
| `slack` | `name`, `url` | Slack-compatible incoming webhook (works with Mattermost, etc.). Optional `channel`. |
| `webhook` | `name`, `url` | Generic structured JSON webhook. Use `headers` for auth. |
| `telegram` | `name`, `bot_token`, `chat_id` | Telegram Bot API. |

`email` is reserved in the schema for future work, but delivery is not implemented yet. Do not
configure `type: email` — notifications for that channel will fail.

```yaml
notification_channels:
  - name: Mattermost
    type: slack
    is_default: true                     # used when a monitor has no per-monitor channel
    url: ${MATTERMOST_WEBHOOK_URL}
    channel: "#alerts"

  - name: Demo Webhook
    type: webhook
    url: ${DEMO_WEBHOOK_URL}             # create a temporary receiver at webhook.site or Beeceptor
    headers:
      Authorization: Bearer ${DEMO_WEBHOOK_TOKEN}
    is_default: false
```

**Routing:** per-monitor channels take precedence; channels marked `is_default: true` are the
fallback for monitors that don't name their own.

**Custom message text:** Slack, Telegram and webhook channels can override the notification text
with `templates.down`, `templates.recovered` and `templates.escalation`. Supported placeholders:
`{monitor}`, `{count}`, `{error}`, `{status}`.

```yaml
  - name: Ops Webhook
    type: webhook
    url: ${OPS_WEBHOOK_URL}
    templates:
      down: "{monitor} is {status}: {error}"
      recovered: "{monitor} recovered after {count} checks"
```

### Generic webhook payload

`type: webhook` channels POST JSON:

```json
{
  "monitor": { "id": "example-api", "name": "Example API" },
  "incidentId": "incident-123",
  "status": "error",
  "eventType": "down",
  "count": 3,
  "errorMessage": "Connection refused",
  "message": "🔴 **Example API is DOWN** — 3 consecutive failures: Connection refused",
  "cronTimestamp": 1781395201000,
  "timestamp": "2026-06-14T00:00:01Z"
}
```

`errorMessage`, `message` and `cronTimestamp` are optional. Use `headers` for authentication,
e.g. `Authorization: Bearer ${DEMO_WEBHOOK_TOKEN}`.

## `monitors`

Each monitor declares what to probe and its alert rules. Required fields: `name`, `type`, `mode`
(and `target` for everything except heartbeat). `visibility` (`public` | `private`) controls
which status page shows it; `interval` accepts `s` / `m` / `h` / `d` suffixes (60s minimum).

```yaml
monitors:
  - name: Example API
    type: http
    mode: external
    visibility: public
    target: https://api.example.com/health
    interval: 60s
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
        cooldown: 300s
```

### HTTP / HTTPS monitors

`type: http`. Probes `target` (a URL) and checks the response. Condition: `status != 200`
(any non-2xx is treated as down). Supports `latency` and `ssl_expiry` conditions.

#### Custom request headers

`http` monitors can send custom request headers — useful for endpoints that expect an auth token, an
environment hint, or other routing header. Every HTTP probe also sends a fixed
`User-Agent: heartbeatflare/1.0` to make probes easy to spot in access logs. Header values support
`${VAR}` substitution from Worker secrets, resolved at probe time — the literal `${VAR}` is never
sent to the target, and if the referenced secret is unset the check fails (status `down`, opening an
incident) instead of probing.

```yaml
  - name: Example API
    type: http
    mode: external
    visibility: private
    target: https://api.example.com/health
    interval: 60s
    headers:
      X-Healthcheck-Token: ${HEALTHCHECK_TOKEN}
      X-Environment: production
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
```

`headers` are valid only on `type: http` — the config schema and `wrangler:generate` reject them on
tcp/dns/heartbeat monitors. They are **not** stored in D1; they ship to the Worker as the generated
`PROBE_HEADERS` var (with `${VAR}` placeholders preserved) and therefore update on **deploy**, not on
a standalone `config:import`. `secrets:sync` picks up the referenced secrets automatically. Keep the
total small — Worker plain-text vars are limited to a few KB on the Free plan.

The fixed User-Agent cannot be set or overridden by config — a `User-Agent` header fails generation.

> ⚠️ The default User-Agent is for request **identification only**, not authentication — it is
> non-secret and trivially spoofed. Use a `${VAR}` secret header for any access that must be gated.

### TCP monitors

`type: tcp`. `target` is `host:port`. Condition: `connect != true` (connection could not be
established). Supports `latency` and, with `ssl: true`, `ssl_expiry`.

### DNS monitors

`type: dns`. `target` is a hostname. Condition: `status != up` (query returned no records or
timed out).

### Internal monitors (`mode: internal`)

> **Beta**, builds on [Cloudflare Workers VPC](https://developers.cloudflare.com/workers-vpc/).

By default monitors are `mode: external` and probe over the public internet. `mode: internal`
monitors probe **private** targets through a Workers VPC binding declared under
[`deploy.vpc`](#deployvpc-internal-monitors). Set `vpc_binding` to the name of a network or service
binding; HTTP probes use the binding's `fetch()`, TCP probes its `connect()`.

```yaml
  - name: Internal API
    type: http
    mode: internal
    vpc_binding: DEMO_SERVICE      # a deploy.vpc network/service binding name
    visibility: private
    target: http://demo.internal/health
    interval: 60s
    ssl: false
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
```

**v1 rules (enforced at config import — the import fails fast on violation):**

- Supported types are `http` and `tcp` only. `type: dns` is **not supported** for internal monitors
  (the DoH resolver is a public service).
- `vpc_binding` is **required** and must name a binding declared under `deploy.vpc`. It must **not**
  be set on `mode: external` monitors.
- SSL/TLS expiry checks are **skipped** for internal monitors (the cert APIs are public and cannot
  inspect private targets), so `ssl: true` is rejected — set `ssl: false` or omit it.
- TCP over VPC is treated as plaintext connectivity.
- For a **service** binding the `target` host:port is ignored (the destination is fixed by
  `service_id`); for a **network** binding `target` is the real private address.

If an internal monitor's `vpc_binding` is missing from the deployed Worker, its checks record a
`down` result with a clear configuration error rather than probing the public network.

#### Internal HTTPS and TLS trust

For an **HTTPS** internal target, Workers VPC validates the origin certificate and trusts **only
publicly-trusted CAs and Cloudflare Origin CA**. A self-signed or internal/private-CA certificate
makes the TLS handshake fail, so `binding.fetch()` throws and the check is recorded `down` with a TLS
error. heartbeatflare cannot relax this — Workers `fetch()` has no "skip verification" option, and the
trust decision lives on the VPC resource (which heartbeatflare only consumes). Options:

- **Prefer `http://`** for the private target. Through an `http`-type VPC Service or a tunnel-backed
  network the request is still encrypted in flight to your network by the tunnel — plaintext-to-origin
  does not mean plaintext on the wire — and there is no certificate to validate.
- For HTTPS to a target with a non-public certificate via a **VPC Service**, set the service's TLS
  verification mode when you create/update it (this is VPC infrastructure, managed outside
  heartbeatflare): `verify_full` (default) → `verify_ca` (skip hostname) → `disabled` (no server-cert
  verification, required for self-signed). For example:

  ```bash
  npx wrangler vpc service create my-service --type http --https-port 443 \
    --tunnel-id <TUNNEL_ID> --cert-verification-mode disabled
  ```

- A **VPC Network** binding has no per-target certificate override, so HTTPS over a network binding
  requires either `http://` or a publicly-trusted / Cloudflare Origin CA certificate on the origin.

### Heartbeat (push) monitors

`type: heartbeat`. A dead-man's switch: instead of the Worker probing a target, your job calls the
Worker. `target` is omitted. Each successful run sends `POST /beat/<monitor-id>/<token>`; if no beat
arrives within `interval`, the scheduler records a miss, and after `failures` consecutive misses it
opens an incident. Use it for cron jobs, backups and queue workers.

```yaml
  - name: Backup job
    type: heartbeat
    mode: external
    visibility: private
    interval: 10m            # the expected beat period
    alerts:
      - condition: "status != up"
        severity: critical
        failures: 1          # open an incident after this many missed intervals
        recovery: 1
```

The monitor name maps to two derived identifiers you never type in YAML but both need:

| Form | Example | Where it's used |
| --- | --- | --- |
| Monitor id (lowercase, hyphenated) | `backup-job` | the beat URL path |
| Worker Secret (uppercase, underscored) | `HEARTBEAT_BACKUP_JOB_TOKEN` | holds the token value |

The token is **not** stored in `config.yaml` or D1 — only the reference `secret:HEARTBEAT_…_TOKEN`
is imported. The value lives in a Worker Secret **generated automatically on deploy**: the
`secrets:sync` step creates a random token for any heartbeat monitor that doesn't already have one
and **prints it once** in the deploy output:

```
=== New heartbeat tokens generated — SAVE THESE NOW (not shown again) ===
  Monitor:  Backup job
  Secret:   HEARTBEAT_BACKUP_JOB_TOKEN = 9f3a…c21
  Beat URL: curl -fsS -X POST "https://status.example.com/beat/backup-job/9f3a…c21"
```

Cloudflare never shows a secret value again — save it then. Existing tokens are kept across deploys;
to **rotate**, delete the secret in the dashboard (**Workers & Pages → your worker → Settings →
Variables and Secrets**) and redeploy. You can also pre-set your own value via CI env or
`npx wrangler secret put HEARTBEAT_BACKUP_JOB_TOKEN`, and it is used instead of a generated one.

Have the job beat on each successful run:

```sh
curl -fsS -X POST "https://status.example.com/beat/backup-job/$HEARTBEAT_BACKUP_JOB_TOKEN"
```

The endpoint is `POST`-only (`405` otherwise), never cached, and not behind Cloudflare Access. It
returns `204` on a valid beat and `404` for an unknown monitor, wrong/missing token or disabled
monitor — so it never reveals whether a monitor exists. Requests are rate-limited per source IP and
per monitor (`429`), and repeated beats well inside the interval are accepted without a D1 write.

### SSL/TLS expiry checks

For `http` and `tcp` monitors, add an `ssl_expiry` alert condition (TCP monitors also need
`ssl: true`). Two default rules (`< 7` warning, `< 1` critical) are added automatically unless you
configure your own. SSL incidents are tracked independently from connectivity incidents.

## `alerts`

Each monitor has one or more alert rules. A rule tracks incidents independently — an SSL incident
does not suppress a connectivity incident and vice versa.

### Alert parameters

| Field | Required | Description |
| --- | --- | --- |
| `condition` | yes | What triggers the alert — see [Supported conditions](#supported-conditions). |
| `severity` | yes | `critical` or `warning`. |
| `failures` | yes | Consecutive failing checks before an incident opens. |
| `recovery` | yes | Consecutive successful checks before the incident resolves. |
| `cooldown` | no | Minimum pause between two incidents on the same monitor (e.g. `300s`, `5m`), measured from when the previous incident **closed**. Prevents spam from a flapping target. Default `0`. |
| `escalation` | no | Re-send a "STILL DOWN" notification if the incident stays open longer than this interval (e.g. `15m`, `2h`). Repeats until resolved. Default: disabled. |

### Supported conditions

| Condition | Monitor types | Meaning |
| --- | --- | --- |
| `status != 200` | http | HTTP response code is not 200 (any non-2xx is down). |
| `connect != true` | tcp | TCP connection could not be established. |
| `status != up` | dns, heartbeat | DNS query returned no records / timed out; for heartbeat, an expected beat was missed. |
| `latency >= 500` | http, tcp | Round-trip latency exceeded the threshold in ms (`>`, `<`, `>=`, `<=` supported). |
| `ssl_expiry < 14` | http, tcp (with ssl) | Days until certificate expiry below the threshold. |

## `maintenance`

Announce planned work with an optional top-level `maintenance:` list. While a window is active the
affected monitors are **not probed** (no false incident, uptime unaffected) and the status page
shows a banner. Times are ISO 8601 UTC. Omit `monitors:` for a global window covering everything.

```yaml
maintenance:
  - title: "Database migration"
    body: "Upgrading the primary Postgres cluster."
    starts_at: "2026-06-20T02:00:00Z"
    ends_at: "2026-06-20T04:00:00Z"
    monitors: [Example API]    # omit for all monitors
```

Windows are imported into D1 by `config:import` like everything else — declaring one is a config
change (commit + deploy). Removing a window from YAML deletes it.

## Public endpoints

| Endpoint | Description |
| --- | --- |
| `/public` | Public status page (public monitors only). |
| `/feed.xml` | Atom 1.0 feed of incidents + maintenance windows (public monitors only). |
| `/badges` | Public badge gallery with rendered previews, direct SVG URLs, Markdown snippets and HTML snippets for all public monitors. |
| `/badge/<monitor>.svg` | SVG status badge for a public monitor; `?label=` overrides the left text. Private/unknown monitors return 404. |
| `POST /beat/<monitor-id>/<token>` | Heartbeat ingest. `204` on success; `404`/`405`/`429` otherwise. Not cached, no Access (see [Heartbeat monitors](#heartbeat-push-monitors)). |

`<monitor>` is the stored monitor id (derived from the monitor name at import time). Use `/badges`
on your deployed Worker to copy ready-to-use embed snippets. A direct Markdown badge looks like:

```markdown
![status](https://status.example.com/badge/example-api.svg)
```

The `/private` status page additionally shows private monitors and the optional Infrastructure
Usage block; it is gated by Cloudflare Access (see [`auth`](#auth-optional)).

## Secrets and `${VAR}` placeholders

Sensitive values — webhook URLs, tokens, Access identifiers — never go into `config.yaml` or D1 as
literals. Reference them as `${VAR}` placeholders; the Worker resolves the actual value from its
environment (Cloudflare Worker Secrets) at send time.

```
config.yaml   url: ${MATTERMOST_WEBHOOK_URL}        (placeholder)
      ↓ config:import
D1            notification_channels.configuration = {"url": "${MATTERMOST_WEBHOOK_URL}", ...}
      ↓ at send time
Worker        value = resolve(env, "${MATTERMOST_WEBHOOK_URL}")
```

A D1 dump therefore contains placeholders, not credentials. The `secrets:sync` deploy step discovers
every `${VAR}` referenced in `config.yaml` and pushes the matching secrets to the Worker — so adding
`url: ${MY_NEW_HOOK}` just means providing `MY_NEW_HOOK` as a CI secret or `wrangler secret put`.
For how secrets are supplied and synced, see [Runtime Worker secrets](DEPLOYMENT.md#runtime-worker-secrets)
in the deployment guide.

## Import semantics

`config:import` runs on every deploy and is idempotent.

**Owned by import (config tables):** `monitors`, `alert_rules`, `notification_channels`,
`monitor_notification_channels`.

**Never touched (runtime tables):** `monitor_state`, `monitor_executions`, `incidents`,
`notification_deliveries`.

**Deletion:** removing a monitor from YAML sets `monitors.enabled = false` (soft delete) — runtime
history and open incidents are preserved. Removing a maintenance window deletes it.

## Full example

A complete, deployable starter lives in [`config.example.yaml`](../config.example.yaml) at the repo
root — copy it to `config.yaml` and edit.
