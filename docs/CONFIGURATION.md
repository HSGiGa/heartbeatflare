# Configuration

All platform configuration lives in [`config.yaml`](../config.yaml), validated by
[`config.schema.json`](../config.schema.json). It is the single source of truth: the Worker
never reads YAML at runtime — `config.yaml` is imported into D1 by the `config:import` deploy
step, and the Worker operates exclusively against D1.

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

Where incident open / resolve / escalation messages are delivered. Three channel types:

| `type` | Required fields | Notes |
| --- | --- | --- |
| `slack` | `name`, `url` | Slack-compatible incoming webhook (works with Mattermost, etc.). Optional `channel`. |
| `webhook` | `name`, `url` | Generic structured JSON webhook. Use `headers` for auth. |
| `telegram` | `name`, `bot_token`, `chat_id` | Telegram Bot API. |

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

### TCP monitors

`type: tcp`. `target` is `host:port`. Condition: `connect != true` (connection could not be
established). Supports `latency` and, with `ssl: true`, `ssl_expiry`.

### DNS monitors

`type: dns`. `target` is a hostname. Condition: `status != up` (query returned no records or
timed out).

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
| `/badge/<monitor>.svg` | SVG status badge for a public monitor; `?label=` overrides the left text. Private/unknown monitors return 404. |
| `POST /beat/<monitor-id>/<token>` | Heartbeat ingest. `204` on success; `404`/`405`/`429` otherwise. Not cached, no Access (see [Heartbeat monitors](#heartbeat-push-monitors)). |

`<monitor>` is the slug of the monitor name (lowercased, non-alphanumerics → `-`). Embed a badge:

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

A complete, deployable starter lives in [`config.yaml`](../config.yaml) at the repo root.
