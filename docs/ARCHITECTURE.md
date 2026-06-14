# Monitoring Platform Architecture

> **Implementation status (MVP).** This document describes the implemented system.
> The MVP is a **single Cloudflare Worker** (`src/index.ts`) exposing three entry
> points — `fetch` (status pages + API), `scheduled` (cron probing + maintenance),
> and `queue` (notification delivery). The earlier multi-Worker / Service-Bindings
> design and OpenMetrics scraping are **not implemented**; OpenMetrics remains a
> Phase 2 path. Sections below reflect the code as built.

## Overview

Cloudflare-native uptime monitoring platform. A single Worker probes external
targets on a cron trigger, stores operational state and time-series in D1,
generates incidents, and delivers notifications via a Cloudflare Queue.

Supported monitoring capabilities (implemented):

- HTTP/HTTPS monitoring (status code, response time)
- TCP port monitoring (reachability, connect latency)
- DNS monitoring (resolution via DoH)
- Heartbeat (push) monitoring — jobs POST to `/beat/<id>/<token>`; missed beats open incidents
- SSL/TLS certificate expiry (via external CT/cert APIs — see SSL section)
- Alerting and incident management (connectivity + SSL, independent)
- Maintenance windows (planned work; affected monitors not probed while active)
- Public + private status pages (one Worker, path-based routing)
- Atom feed (`/feed.xml`) and embeddable SVG status badges (`/badge/<monitor>.svg`)

Planned (Phase 2, not implemented): OpenMetrics collection from internal services
via Cloudflare Tunnel.

## Architecture

```
        Public Internet targets
   (HTTP/HTTPS, TCP ports, DNS, TLS certs)
                    ^
                    | direct probe (fetch / cloudflare:sockets / DoH)
                    |
+---------------------------------------------------------------+
|                  Single Worker (heartbeatflare)               |
|                                                               |
|  fetch()      → status pages (/public, /private) + JSON API   |
|  scheduled()  → cron (every 1 min):                           |
|                   • select due monitors, probe (bounded       |
|                     concurrency), store results               |
|                   • evaluate alerts → open/resolve incidents  |
|                   • hourly uptime rollup, daily cleanup       |
|  queue()      → deliver notifications                         |
|                   (Slack/webhook/Telegram)                    |
|                                                               |
+----------------+--------------------------+-------------------+
                 |                          ^
   read/write    |                          | enqueue on incident
                 v                          | open / resolve
          +------------+          +----------+-----------+
          | D1 Database|          | Notification Queue   |
          +------------+          | (Cloudflare Queues)  |
                                  +----------------------+
```

The same Worker is both the queue **producer** (alert evaluation enqueues a
message on incident open/resolve) and the queue **consumer** (`queue()` handler
delivers it). There are no Service Bindings and no separate Workers.

## Core Components

### Scheduler (`scheduled()` in `src/scheduler.ts`)

**Purpose:** Drives all probing and periodic maintenance.

**Responsibilities:**
- Runs on Cron Trigger every 1 minute.
- One batched read at the start of each tick loads all enabled monitors (+ their
  `monitor_state`), all enabled alert rules, and all currently-open incidents.
- Selects due monitors (`last_check_at + interval_seconds <= now`), **sorted
  oldest-checked first** so that, when more than `MAX_CHECKS_PER_RUN` (15) are due,
  no monitor starves.
- Probes inline (no Service Bindings, no separate Worker) with bounded
  concurrency (`MAX_CONCURRENT_CHECKS` = 5) and a per-check timeout
  (`PER_UNIT_MS`). Each probe writes results and evaluates alerts.
- **Heartbeat (push) monitors are not probed.** The same tick checks each `heartbeat`
  monitor for *missed* beats: the deadline is measured from the last beat received
  (`monitor_state.last_check_at`, written by the `/beat` endpoint) or from `created_at`
  if it has never beaten (a grace period). It records one synthetic `down` per newly-missed
  interval — deduplicated on the stored failure count so uptime and the write budget stay
  honest — then runs the normal alert evaluation, opening an incident once the misses reach
  `failure_count`. These run inline, make no subrequest, and don't count toward the probe cap.
- Hourly (`getUTCMinutes() === 0`): recomputes `uptime_daily` from `uptime_hourly`.
- Daily (~04:30 UTC): cleanup (see Retention).

**Probe implementations (`src/probes.ts`):**

| Type | Implementation |
|---|---|
| HTTP/HTTPS | `fetch()` with a 10s timeout; `res.ok` = up |
| TCP port | `connect()` from `cloudflare:sockets`, 10s timeout |
| DNS | DoH query to `cloudflare-dns.com/dns-query`; non-empty answer = up |
| SSL/TLS expiry | external API (ssl-checker.io, fallback crt.sh) — see SSL section |

SSL expiry is probed alongside HTTP/TCP checks when the monitor has `ssl_check = 1`
and a derivable hostname.

**Fan-out limit:** a single Worker invocation can make at most 50 subrequests on
the Free Plan, and the cron tick itself has a CPU/time budget. `MAX_CHECKS_PER_RUN`
caps checks per tick; beyond that, the oldest-checked-first ordering rotates work
across consecutive ticks.

---

### Result store (`storeResult()` in `src/alerts.ts`)

Persists each check result, minimising D1 writes:
- Upserts `monitor_state` (status, timestamps, consecutive counters, SSL columns) — 1 write/check.
- Upserts the hourly aggregate `uptime_hourly` — 1 write/check.
- Writes a raw `metric_series` row **only when actionable** (failure, status
  transition, or first sample of the hour) — not every check.
- Writes `monitor_executions` **only on status change or failure**.

**Write-amplification budget (Free Plan):** D1 allows 100k writes/day. Steady-state
writes are ~2 per check (state + hourly aggregate).

---

### Alert evaluator (`evaluateAlerts()` in `src/alerts.ts`)

Converts check results into incidents. Incidents are tracked **independently per
metric class**, derived from the open-incidents snapshot loaded at tick start
(the `incidents` table is the source of truth; class = `alert_rules.metric_name`,
or the `__connectivity__` sentinel when `metric_name IS NULL`).

- **Connectivity** (metric_name NULL): opens an incident after `failure_count`
  consecutive failures (subject to `cooldown_seconds`), resolves after
  `recovery_count` consecutive successes.
- **SSL expiry** (metric_name `ssl_expiry`): opens at the highest matching
  severity when `ssl_days_left < threshold`, resolves when the cert no longer
  triggers any rule.

The two classes do **not** block each other: an open SSL-warning no longer
suppresses a connectivity down-incident. Incident open/resolve writes (incident
row + `monitor_state.active_incident_id` hint) go through a single `DB.batch()`;
the notification is enqueued only after that batch commits.
`monitor_state.active_incident_id` is a denormalised hint for the active
*connectivity* incident only; SSL incidents live solely in the `incidents` table.

**Writers.** For probe-based monitors the scheduler is the single writer (one evaluation per monitor
per tick). `heartbeat` monitors add a second writer — the `/beat` endpoint, which records an `up`
sample and runs recovery on an incoming beat while the scheduler still handles miss detection. The
two never act on one monitor in the same instant in practice; the only shared-state hazard is
`consecutive_successes` for heartbeat `recovery_count > 1` under concurrent beats, which may
under/over-count by one — an accepted trade-off for a push monitor.

---

### Notification delivery (`queue()` in `src/queue.ts`)

Consumes the `NOTIFICATION_QUEUE`. For each message, resolves the monitor's
channels (per-monitor assignments, else defaults) and delivers.

- **Implemented channels:** Slack and generic Webhook (HTTP POST `{ text }`), plus
  Telegram (`sendMessage` with HTML formatting).
- Email is **not implemented** and would record a `failed` delivery —
  do not configure it (email was removed from `config.yaml`).
- Each attempt is recorded in `notification_deliveries` with the real attempt
  count (`msg.attempts`).
- **Retry:** if no channel succeeds, `msg.retry()` (the queue's `max_retries`
  caps attempts before drop). On partial success the message is acked to avoid
  double-notifying already-delivered channels.

Configuration values support `${VAR}` substitution resolved from the Worker's
environment at send time (e.g. `url: ${MATTERMOST_WEBHOOK_URL}`).

## Data Storage

### D1 Database

Stores operational state and execution history.

**monitors**
```
id                    -- slug derived from name
name
type                  -- http | tcp | dns | heartbeat (openmetrics reserved); plain TEXT, no CHECK
mode                  -- external | internal
visibility            -- public | private  (controls status page exposure)
scrape_url            -- target (URL / host:port / hostname); NULL for heartbeat (push) monitors
ssl_check             -- 1 = also probe TLS cert expiry for this monitor (0 for heartbeat)
interval_seconds      -- probe interval; for heartbeat, the expected beat period
enabled
paused                -- 1 = temporarily not probed (still shown)
group_id              -- nullable FK → monitor_groups (feature: components/groups; inert until built)
heartbeat_token       -- heartbeat monitors only: `secret:<NAME>` ref to the token's Worker Secret (never the value)
created_at
updated_at
```

**alert_rules** — evaluation rules and incident configuration
```
id
monitor_id
metric_name           -- nullable; 'ssl_expiry' for SSL rules, NULL for connectivity
condition             -- eq | gt | lt | gte | lte
threshold             -- numeric value; SSL thresholds are in days
severity              -- warning | critical
failure_count         -- consecutive failures required to open incident
recovery_count        -- consecutive successes required to resolve incident
cooldown_seconds      -- minimum time after last resolve before re-opening
enabled
```

For connectivity rules `metric_name IS NULL` — the condition evaluates the check
result (up/down) directly. SSL-expiry rules use `metric_name = 'ssl_expiry'` with
`condition = 'lt'` and a day threshold (e.g. `lt 7` warning, `lt 1` critical).
The import step auto-adds default SSL rules (7-day warning, 1-day critical) for
http/tcp monitors with `ssl` enabled when none are specified.

**monitor_state** — current operational state per monitor
```
monitor_id
status                    -- up | degraded | down | unknown
last_check_at
last_success_at
consecutive_failures
consecutive_successes
active_incident_id        -- denormalised hint: the active *connectivity* incident
                          --   only. SSL incidents are not reflected here; the
                          --   incidents table is the source of truth.
ssl_not_after             -- cached cert expiry timestamp
ssl_issuer                -- cached cert issuer
```

**monitor_executions** — execution history for investigation and debugging
```
id                    -- per-check execution UUID
monitor_id
started_at
completed_at
status                -- up | degraded | down
latency_ms
error
worker_region
```

**Written only on status change or failure** (not every successful check) to stay within the D1 write budget. A steady-state healthy monitor produces near-zero execution rows. Retention: **48 hours**, purged by the daily cleanup (not read by the UI).

**incidents**
```
id
monitor_id
alert_rule_id         -- nullable FK → alert_rules; NULL for manual / maintenance incidents
status                -- open | resolved
severity              -- plain TEXT (rule severity, or operator input for manual incidents)
started_at
resolved_at
reason
last_notified_at      -- last notification time (escalation re-notify cadence)
acknowledged_at       -- nullable (feature: acknowledge; inert until built)
acknowledged_by       -- nullable (feature: acknowledge)
created_by            -- nullable operator id for manual incidents; NULL = system-generated
```

The `incident_updates(id, incident_id, created_at, status, message)` table holds the incident
timeline (investigating → identified → resolved) for the manual-incidents feature — also inert
until that code lands.

Incident visibility is inherited from the monitor (`monitors.visibility`) — there is no separate column. The public status page shows incidents only for public monitors.

Retention: resolved incidents are purged after **120 days** by the daily cleanup —
the status page colours its 90-day uptime bars from incidents, so a shorter window
would degrade the UI. **Open incidents are never purged**, regardless of age.

**notification_channels**
```
id
name
type                  -- slack | webhook | telegram  (email defined but not implemented)
configuration         -- JSON; string values may contain ${VAR} env references
is_default            -- fallback channel when monitor has no explicit channels
enabled
```

`configuration` holds non-sensitive config plus `${VAR}` placeholders (e.g. a
webhook `url`). The actual secret value is resolved from the Worker's environment
at send time, so the secret itself is never written to D1. (A legacy `secret_name`
column exists in the schema but is unused by the current code.)

**monitor_notification_channels** — per-monitor channel assignments
```
monitor_id
channel_id
notify_on             -- JSON array: ["incident_open", "incident_resolved", "degraded", "ssl_expiring"]
enabled
```

Routing logic:
- If a monitor has rows in `monitor_notification_channels` → notify those channels
- Otherwise → notify all channels where `is_default = true`

**notification_deliveries** — delivery tracking for retry and audit
```
id
incident_id
channel_id
status                -- pending | sent | failed
attempt_count
last_attempt_at
error
```

**metric_series** — raw time-series, one row per *actionable* check
```
id
monitor_id
recorded_at
availability        -- 0 | 1
latency_ms          -- nullable
response_time_ms    -- nullable (unused)
ssl_expiry_seconds  -- nullable (unused; SSL expiry is cached on monitor_state)
tcp_connect_ms      -- nullable
```

Written only on failure, status transition, or the first sample of an hour (see
Result store). Retention: **7 days**, purged by the daily cleanup.

**uptime_hourly / uptime_daily** — pre-aggregated uptime + latency
```
monitor_id, hour|day, total_checks, up_checks, avg_latency_ms, latency_count
```
Every check upserts the current `uptime_hourly` bucket (cheap, 1 write); the hourly
cron rolls `uptime_hourly` up into `uptime_daily`. The status page reads these
aggregates (≈900 rows for 90 days) instead of scanning `metric_series`.
`uptime_hourly` retention: 48 hours; `uptime_daily` is retained for the 90-day view.

**maintenance_windows / maintenance_window_monitors** — planned-work windows
```
maintenance_windows:          id, title, body, starts_at, ends_at, enabled, created_at, updated_at
maintenance_window_monitors:  (window_id, monitor_id)   -- empty set for a window = global (all monitors)
```
Declared in `config.yaml` and imported into D1 like monitors/channels (the Worker never writes
them). While a window is active (`starts_at <= now < ends_at`) the scheduler **skips probing** the
affected monitors — no probe means no check result, so no connectivity incident is opened and uptime
isn't dragged down by expected downtime; escalations for those monitors are also suppressed. The
status page renders a maintenance banner and marks affected monitors "Maintenance"; the Atom feed
includes windows as entries. Bars during a window show as "no data" (grey).

**Free Plan write budget (D1: 100k writes/day):**
```
Per check:  1 monitor_state upsert + 1 uptime_hourly upsert = 2 writes
            (metric_series only when actionable; monitor_executions only on change)

30 monitors × 60s interval:  30 × 1,440 × 2  =  86,400 writes/day  (near ceiling)
```
The MVP comfortably supports ~25–30 external monitors at a 60s interval. Larger fleets use longer intervals.

Used for:
- Dashboards
- Historical views
- SLA calculations
- Trend analysis

**Phase 2 upgrade path:** when Analytics Engine availability on Free Plan is confirmed or the project moves to a paid plan, `metric_series` writes can be migrated to Analytics Engine with no changes to the rest of the system — Result Store is the only write point.

---

### Schema evolution under additive-only migrations

Migrations are **additive-only** (`npm run migration:lint` blocks `DROP`/`RENAME`). In SQLite,
changing a `CHECK` constraint or dropping `NOT NULL` is impossible via `ALTER` — it requires a full
table rebuild (`CREATE …_new` → `INSERT … SELECT` → `DROP TABLE` → `RENAME` under
`PRAGMA foreign_keys=OFF`, with a `-- lint-ok:` override). So every `CHECK (… IN (…))` enum and every
`NOT NULL` column is effectively a **one-way door**. The v1 baseline is forward-proofed accordingly
so these future features need no schema migration:

- **Growable enums carry no `CHECK`.** `monitors.type`, `alert_rules.condition`/`severity`,
  `incidents.severity`, `notification_channels.type` are plain `TEXT` — input is validated at import
  by `config.schema.json`. New monitor types, conditions, severities or channel types add no rebuild.
- **`incidents.alert_rule_id` is nullable**, plus `acknowledged_at` / `acknowledged_by` / `created_by`
  columns and an `incident_updates` timeline table — for manual incidents and acknowledge/timeline.
- **OpenMetrics / arbitrary metrics:** `metric_samples(monitor_id, metric_name, value, recorded_at,
  labels)` (raw key/value) plus `metric_sample_hourly` / `metric_sample_daily` aggregates
  (count/sum/min/max → avg), mirroring the uptime rollups. Result store is the only write point.
- **Components/groups:** `monitor_groups` + `monitors.group_id` (nullable, `ON DELETE SET NULL`).
- **Push heartbeat** (implemented): `monitors.heartbeat_token` holds the `secret:<NAME>` token
  reference; `type=heartbeat` is a plain-`TEXT` value. The `/beat` endpoint and scheduler miss
  detection landed with no schema migration.
- **Maintenance windows** (implemented): `maintenance_windows` + `maintenance_window_monitors`;
  active windows are handled by skipping probes, so no per-sample "during maintenance" marker is needed.

These tables/columns exist in the baseline but are inert until the corresponding feature code lands.

**Out of scope (single-account self-host).** Multi-tenancy / `account_id` is deferred (see Roadmap);
it can be added additively (nullable) if ever needed. **Multi-region probing** is also deferred — it
would add a region dimension to `monitor_state`/`uptime_*` primary keys (a rebuild), so it is left
out of the baseline intentionally. Tracked in `internal/current-plan.md`.

---

### Optional R2 Storage

Used for:
- Raw OpenMetrics payloads
- Debug snapshots
- Audit archives
- Incident evidence

Not required for MVP.

## Monitor Status Model

```
unknown   -- no checks completed yet
up        -- all checks passing within thresholds
degraded  -- checks passing but a warning threshold exceeded
down      -- check failing (probe_success == 0 or connection refused)
```

> **Status note:** the current probe path sets only `up` or `down` on
> `monitor_state.status`. `degraded` is defined in the schema and rendered by the
> status page, but is **not currently produced** — warning conditions (e.g. SSL
> expiry) open a *warning incident* without changing the monitor's status. Driving
> `monitor_state.status = 'degraded'` from warning thresholds is a Phase 2 item.

Intended meaning of `degraded` (Phase 2):
- SSL certificate expires soon
- HTTP response latency > configured threshold
- TCP connect time > configured threshold

## Status Pages

Two read-only views over the same data, served by the Worker's `fetch()` handler,
routed by **path** (not hostname).

```
   GET /            → 302 /public
   GET /public      → public view  (no session; WHERE visibility = 'public')
   GET /private     → private view (requires a valid Cloudflare Access session)
   GET /api/status  → JSON; public-scoped unless authenticated
   GET /api/history → JSON; paginated incident history
   GET /feed.xml    → Atom 1.0 feed of incidents + maintenance (public monitors only)
   GET /badge/<m>.svg → SVG status badge (public monitors only; 404 otherwise)
   /auth/login | /auth/logout
```

### Path routing + fail-closed visibility

The Worker derives a session from the `Cf-Access-Jwt-Assertion` header (JWT verified
against the team's Access certs, see `src/auth.ts`). Then:

- `showAll = session !== null` — **fail-closed**. Private monitors, their target
  URLs, alert rules, and the usage block are shown **only** with a valid session.
- A missing or disabled `auth_config` means *public-only*, never *everything open*.
  (Earlier behaviour was fail-open; this was fixed.)

**Defense in depth:** visibility is enforced in Worker code (`WHERE visibility =
'public'` for unauthenticated requests), independently of the Cloudflare Access
gate on `/private`. Even if Access is misconfigured, the public path never returns
private data.

### Edge caching

Unauthenticated responses (`/public`, and public-scoped `/api/status`,
`/api/history`) are stored in the Cloudflare **Cache API** (`caches.default`) for
60s under a public-namespaced key, and carry `Cache-Control: public, max-age=60`.
Repeat public traffic — which spikes precisely during an incident — is served from
the colo cache without re-invoking the Worker or touching D1. Authenticated views
are always `no-store`. The public cache key is namespaced so an authenticated
request can never match a cached public response.

### Rendering

Server-rendered HTML inline in the Worker, with a small inline `<script>` for the
history tab, 90-day uptime bars, and tooltips. No build step, no Static Assets binding.

### Public Status Page

- Accessible without authentication
- Shows only monitors with `visibility = 'public'`
- Current status + active incidents + 90-day uptime bars + paginated incident history

Status vocabulary (mapped from internal `monitor_state.status`):

```
internal    public
up        → Operational
degraded  → Degraded
down      → Outage
unknown   → Operational   (transient pre-first-check state; see note)
```

**Note on `unknown`:** a public page should not show alarming or confusing states to external users. `unknown` only occurs in the ~1-minute window before a monitor's first check completes, so it is mapped to `Operational`. A monitor *stuck* in `unknown` (e.g. scheduler not running) is an operational fault surfaced on the private page, where operators see the real `Unknown` value.

Per-monitor display: `Name`, `Status`.
Per-incident display: `Title`, `Status`, `Started At`, `Resolved At`.

### Private Status Page

- Protected by Cloudflare Access
- Shows all monitors (public and private)
- Current status + active incidents

Status vocabulary (internal values shown directly):

```
Up
Degraded
Down
Unknown
```

Per-monitor display: `Name`, `Type`, `Status`, `Last Check`.

### Free Plan considerations

The public page is unauthenticated and may receive bursty traffic. Each render is a D1 read; uncached, high traffic could pressure the 100k requests/day and 5M reads/day budgets.

**Mitigation:** the public response sets `Cache-Control: public, max-age=30`, so Cloudflare's edge serves repeat requests from cache without re-invoking the Worker or touching D1. At most one render per 30s per colo regardless of traffic. A 30-second-stale status page is acceptable for the MVP.

The private page is low-traffic (operators behind Access) and is not cached, so it always reflects current state.

### Out of scope (MVP)

Component groups, dependencies, subscriptions, email updates, status page API, SLA reporting, uptime charts, custom incident messages, multiple status pages. (Maintenance windows, an Atom feed and SVG status badges are now implemented.)

## OpenMetrics Model — Phase 2 (not implemented)

Planned design for internal monitors. The platform would evaluate a curated
subset of OpenMetrics values against configured rules in `alert_rules`; raw metric
streams would not be persisted.

**CPU budget note (Free Plan: 10ms CPU per invocation):** Exporters like `node_exporter` emit thousands of metric lines. Parsing the full payload can exceed the 10ms CPU limit. A scraper must parse only the metrics referenced by the monitor's `alert_rules` (filter by `metric_name` while streaming), not deserialize the entire document. Oversized payloads are capped.

Example metrics from blackbox_exporter:
```
probe_success
probe_duration_seconds
probe_http_status_code
probe_ssl_earliest_cert_expiry
probe_tcp_connect_duration_seconds
```

## Monitoring Types

### HTTP/HTTPS (external)
`fetch()` with a 10s timeout. Checks: status code (`res.ok`), response time.

### TCP Port (external)
`cloudflare:sockets connect()` with a 10s timeout. Checks: port reachability, connect latency.

### DNS (external)
DoH query to `cloudflare-dns.com/dns-query`. Up = `Status 0` with a non-empty answer.

### Heartbeat (push)
Inverted: the monitored job calls the Worker, not the other way round. A job `POST`s to
`/beat/<monitor-id>/<token>` (handled in `src/heartbeat.ts`, routed ahead of auth/cache in
`src/routes.ts`); the scheduler raises an incident when beats stop. The endpoint is fail-closed and
write-minimised:

- **Token in a Worker Secret.** D1 stores only `secret:<NAME>` (NAME derived from the monitor id as
  `HEARTBEAT_<ID>_TOKEN`); the value lives in a Cloudflare Worker Secret and is resolved from `env`
  and compared in constant time at beat time. Same `${VAR}`-style indirection as webhook channels —
  a D1 dump never contains the token. The secret is **auto-generated on deploy** by `secrets:sync`
  (`scripts/sync-secrets.ts`): generate-if-missing per heartbeat monitor, printed once to the deploy
  output (Cloudflare never shows a secret value again); an existing token, or one supplied via CI
  env, is used as-is. Rotation = delete the secret and redeploy.
- **Rate limited before any D1 access** — per source IP (`BEAT_IP_RATE_LIMITER`, 60/60s) and per
  monitor id (`BEAT_MONITOR_RATE_LIMITER`, 20/60s); over-limit → `429`.
- **Write throttle.** While the monitor is already `up` with no open connectivity incident and was
  beaten within `max(10, interval/4)` seconds, the beat returns `204` with **no** D1 write. Otherwise
  it records an `up` sample (`storeResult`) and runs recovery evaluation (`evaluateAlerts`).
- **Fail-closed responses.** `204` on a valid beat; `404` for unknown monitor / bad or missing token /
  disabled monitor (never reveals existence); `405` for non-`POST`. The token is never logged.

Miss detection lives in the scheduler (see Scheduler › Responsibilities).

### SSL/TLS expiry (external, opt-in via `ssl_check`)
TLS introspection is unavailable in the Workers sandbox, so cert expiry is fetched
from an external API (ssl-checker.io, fallback crt.sh) and cached 6h in the Cache
API. Treated as a best-effort signal (`ssl_days_left`); the authoritative
connectivity signal remains the HTTP/TCP check itself.

### OpenMetrics (internal) — Phase 2, not implemented
Planned: scrape `/metrics` or `/probe` through a Cloudflare Tunnel and evaluate a
configured subset of metrics. No code today.

## Alerting Flow

```
Check Result (probe, inline in scheduled())
        |
        v
storeResult()
  - upsert monitor_state            (1 write)
  - upsert uptime_hourly            (1 write)
  - write metric_series             (only when actionable)
  - write monitor_executions        (only on status change)
        |
        v
evaluateAlerts()  (gates on the per-class open-incident snapshot)
        |
        +-- connectivity: failures >= failure_count   --> open incident
        +-- connectivity: successes >= recovery_count --> resolve incident
        +-- ssl_expiry:   days_left < threshold        --> open/resolve (independent)
        |
        v  enqueue on NOTIFICATION_QUEUE (only on open/resolve)
        |
queue() consumer
        |
        +-- Slack
        +-- Webhook
        +-- Telegram
        (Email not implemented)
```

## Observability & Logging

Runtime logging goes to **Cloudflare Workers Logs** (`observability.enabled = true`,
`head_sampling_rate = 1`), viewed under Workers & Pages → the Worker → Observability (not Cloudflare
One Insights). Runtime logs are deliberately **not** written to D1 — that would burn the Free Plan
write budget. D1 holds long-term audit only for domain events (`incidents`, `notification_deliveries`).

All logs are structured single-line JSON via `src/log.ts` (`log(level, event, fields)`), gated by a
`LOG_LEVEL` var (default `info`; `debug` adds successful checks and probe timings). Level ordering:
`debug < info < warn < error`; `configureLogging(env)` sets the threshold once per invocation at each
entry point.

| When | Level | Events |
|---|---|---|
| Always | info | `scheduler.tick`, `incident.open`, `incident.resolved`, `incident.escalation` |
| Always | warn | `check.failed`, `notification.delivery_failed`, `notification.retry` |
| Always | error | `check.error`, `auth.error` |
| Debug only | debug | `check.ok` (per successful check + probe timings) |

**Never logged:** secrets or full webhook URLs (delivery-failure logs carry only channel id/type +
error), and per-request public traffic. The Free Plan target is operational visibility, not long-term
log retention; if logs approach the Free limit, lower `head_sampling_rate` or raise `LOG_LEVEL`.

## Cloudflare Free Plan Constraints

The platform runs entirely within the Cloudflare Free Plan.

| Product | Free Limit | Usage |
|---|---|---|
| Workers | 100k requests/day | Single Worker: status pages, API, cron, queue consumer |
| Workers | 10ms CPU/invocation | Bounds per-tick probing work |
| Workers | 50 subrequests/invocation | Bounds checks per tick (`MAX_CHECKS_PER_RUN`) |
| Cron Triggers | 5 per account | 1 used (`* * * * *`); rollup + cleanup run inside it |
| Edge cache | Free | Public pages/API cached 60s via Cache API — caps Worker + D1 load |
| D1 | 5M reads/day, 100k writes/day, 5GB | All data; ~2 writes/check → ~30 monitors at 60s |
| Queues | 100k ops/day (Free) | Notifications only — low volume (only on incident open/resolve) |
| R2 | 10GB, 1M ops/month | Optional, not used |

**Queues are used for notifications only.** Because messages are produced only on
incident open/resolve (not per check), volume stays far below the Free Plan's
100k ops/day. The probing hot path runs inline in the cron tick — no Queues, no
Service Bindings, no second Worker.

**Analytics Engine** is available on the Free Plan (100k data points/day, 10k read queries/day). The MVP deliberately keeps time-series in D1 anyway, for:
- a single storage backend (simpler backup, reconciliation, and import model),
- read-after-write consistency (AE is eventually consistent and queried via the SQL API, not a binding),
- straightforward local development and testing (`@cloudflare/vitest-pool-workers`).

Per the design principle *"introduce services only for a demonstrated scaling problem,"* AE is a **Phase 2 path**, not an MVP dependency. The trigger is concrete: as monitor count approaches the D1 write ceiling (~30 at 60s), moving `metric_series` to AE removes ~half of all D1 writes and roughly doubles capacity to ~60 monitors. At 30 monitors that would be 30 × 1,440 ≈ 43k data points/day — under half the AE free limit. Result Store is the only write point, so the migration is localised.

**Request budget:** 1,440 Scheduler ticks/day + N monitor checks/day. At 30 monitors / 60s: 1,440 + 30×1,440 ≈ 45k requests/day, well under 100k.

---

## Configuration as Code

All platform configuration is defined in YAML and is the source of truth. Workers never read YAML directly — they operate exclusively against D1.

### Flow

```
config.yaml  +  Cloudflare Secrets
      |                |
      +-------+--------+
              |
              v
         CI/CD step
         (on push to main)
              |
              v
           Import
              |
              v
        D1 Database
              |
              v
          Workers
```

### YAML Structure

```yaml
notification_channels:
  - name: Mattermost
    type: slack                          # slack | webhook | telegram (email not implemented)
    is_default: true
    url: ${MATTERMOST_WEBHOOK_URL}       # ${VAR} resolved from Worker env at send time
    channel: "#alerts"

monitors:
  - name: Google
    type: http                           # http | tcp | dns
    mode: external
    visibility: public                   # appears on both status pages
    target: https://www.google.com/generate_204
    interval: 60s
    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 2
        recovery: 2
        cooldown: 300s

  - name: VPN example.com
    type: tcp
    mode: external
    visibility: private                  # private status page only
    ssl: true                            # also probe TLS cert expiry
    target: vpn.example.com:443
    interval: 5m
    alerts:
      - condition: "connect != true"
        severity: critical
        failures: 2
        recovery: 2
      - condition: ssl_expiry < 14       # metric_name = 'ssl_expiry'
        severity: warning
        failures: 1
        recovery: 1
```

### Secrets

Sensitive values (webhook URLs, tokens) are kept out of `config.yaml` and out of
D1 as literals. They are referenced as `${VAR}` placeholders; the Worker resolves
the actual value from its environment (Cloudflare Secrets / vars) at send time.

```
config.yaml   url: ${MATTERMOST_WEBHOOK_URL}     (placeholder)
      |
      v
D1            notification_channels.configuration = {"url":"${MATTERMOST_WEBHOOK_URL}", ...}
      |
      v
Worker        value = resolveVars(env, "${MATTERMOST_WEBHOOK_URL}")  (at send time)
```

A D1 dump therefore contains placeholders, not credentials. (Note: the secret
value reaches the Worker via its bound env; keep real secrets in Cloudflare Secrets,
not in `wrangler.jsonc` `vars`.)

### Import Semantics

The import step is idempotent and runs on every push to main via CI/CD.

**What import owns (config tables):**
- `monitors`
- `alert_rules`
- `notification_channels`
- `monitor_notification_channels`

**What import never touches (runtime tables):**
- `monitor_state`
- `monitor_executions`
- `incidents`
- `notification_deliveries`

**Deletion semantics:** removing a monitor from YAML sets `monitors.enabled = false` (soft delete). Runtime history and open incidents are preserved.

---

## Roadmap

### MVP (Free Plan) — implemented
- External probing: HTTP, TCP, DNS
- SSL/TLS cert-expiry monitoring (external API, best-effort)
- Inline probing in the cron tick (no Queues, no Service Bindings)
- Incident management: independent connectivity + SSL incidents
- Slack + Webhook + Telegram notifications, with queue-based retry
- D1 storage (state, executions, metric_series, uptime aggregates)
- Status pages: public (no auth) + private (Cloudflare Access), single Worker, fail-closed
- Edge caching of public responses via the Cache API
- Heartbeat (push) monitoring with secret tokens (`/beat` endpoint + scheduler miss detection)

### Phase 2
- Internal OpenMetrics scraping via Cloudflare Tunnel (blackbox_exporter etc.)
- Email notification channels
- Separate cron expressions for rollup/cleanup (see ROADMAP.md)
- Tags, Monitor Groups, Monitor Dependencies
- Status page enhancements (component groups, uptime charts, subscriptions, SLA reporting)
- Multi-region probing
- Migrate `metric_series` to Analytics Engine when monitor count nears the D1 write ceiling (~30 at 60s)

### Deferred
- User accounts
- RBAC
- Multi-tenancy
- OpenTelemetry traces
- Distributed agents

## Design Principles

- External probing runs natively in the Worker — no external probe agents.
- TCP connect is the reachability primitive; ICMP is not required.
- Alert evaluation works with operational state + the open-incident snapshot (D1), not with metrics history.
- Incidents are tracked independently per metric class (connectivity vs `ssl_expiry`); the `incidents` table is the source of truth.
- All data lives in D1: operational state, execution history (`monitor_executions`), time-series (`metric_series`), and uptime aggregates.
- The probing hot path runs inline in the cron tick. Queues are used only for notifications (low volume); no Service Bindings, no second Worker.
- Writes are minimised: `monitor_state` + one `uptime_hourly` upsert per check; `metric_series` only when actionable; `monitor_executions` only on status change.
- The MVP must run entirely within Cloudflare Free Plan limits.
- Additional Cloudflare services are introduced only for a demonstrated scaling problem.
- Alerting is incident-based, not check-based. Severity and thresholds are defined in `alert_rules`.
- Notifications are asynchronous via a queue; delivery state is tracked in `notification_deliveries`; failed deliveries retry up to `max_retries`.
- Notification routing: per-monitor channels take precedence; default channels are the fallback.
- Configuration is defined in YAML (version-controlled) and imported into D1 via CI/CD. The Worker never reads YAML.
- Secrets are referenced as `${VAR}` placeholders in config/D1 and resolved from the Worker's environment at send time — credentials never appear as literals in `config.yaml` or D1.
- Status pages are read-only views over the same data; one Worker routes by **path** (`/public`, `/private`). Visibility is **fail-closed**: private data requires a valid session, enforced in Worker code independently of Cloudflare Access.
