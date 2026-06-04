# Monitoring Platform Architecture

## Overview

Cloudflare-native monitoring platform with two collection modes: direct external probing and OpenMetrics pull from internal services via Cloudflare Tunnel.

The platform collects metrics, stores operational state, generates incidents, and sends notifications.

Supported monitoring capabilities:

- Ping / host reachability (TCP connect)
- HTTP/HTTPS monitoring
- TCP port monitoring
- SSL/TLS monitoring
- OpenMetrics collection from internal services
- Alerting
- Incident management

## Architecture

```
+-------------------------------+     +----------------------------------+
|     Public Internet           |     |     Private Network              |
|                               |     |                                  |
|  - HTTP/HTTPS endpoints       |     |  OpenMetrics Exporters           |
|  - TCP ports                  |     |  - blackbox_exporter             |
|  - SSL/TLS certificates       |     |  - node_exporter                 |
|  - Host reachability          |     |  - custom exporters              |
|                               |     |  - OpenTelemetry Collector       |
+---------------+---------------+     |  - Grafana Alloy                 |
                |                     +----------------+-----------------+
                | Direct probe                        |
                |                          Cloudflare Tunnel
                |                                     |
                v                                     v

+----------------------------------------------------------+
|                    Scheduler Worker                      |
|                                                          |
|  - Cron Trigger (every 1 minute)                        |
|  - Determines due monitors                              |
|  - Invokes Probe/Scraper Worker directly via            |
|    Service Bindings (no Queues on Free Plan)            |
|  - Max 50 invocations per tick (subrequest limit)       |
|                                                          |
+------------------+-------------------+------------------+
                   | Service Binding   | Service Binding
                   v                   v

+----------------------+   +----------------------+
|   Probe Worker       |   |   Scraper Worker     |
|                      |   |                      |
|  External checks:    |   |  Internal checks:    |
|  - HTTP/HTTPS        |   |  - Fetch /metrics    |
|  - TCP port          |   |    or /probe via     |
|  - SSL/TLS           |   |    Cloudflare Tunnel |
|  - Ping (TCP L4)     |   |  - Parse OpenMetrics |
|                      |   |  - Normalize data    |
+----------+-----------+   +-----------+----------+
           |                           |
           +------------+--------------+
                        |
                        v

            +---------------------------+
            |       Result Store        |
            |                           |
            |  - Write monitor_state    |
            |  - Write executions log   |
            |  - Write metric_series    |
            +-------------+-------------+
                          |
                          v
                  +-------+----+
                  | D1 Database|
                  +------------+
                 |
                 v

            +---------------------------+
            |     Alert Evaluator       |
            |                           |
            |  Reads D1 state only:     |
            |  - consecutive_failures   |
            |  - consecutive_successes  |
            |  - active_incident_id     |
            |                           |
            |  Writes D1:               |
            |  - open incident          |
            |  - resolve incident       |
            |  - update monitor_state   |
            +-------------+-------------+
                          | Service Binding
                          | (only on incident open/resolve)
                          v

+----------------------------------------------------------+
|                 Notification Worker                      |
|                                                          |
|  - Telegram                                              |
|  - Slack                                                 |
|  - Email                                                 |
|  - Generic Webhook                                       |
|                                                          |
+----------------------------------------------------------+
```

## Core Components

### Scheduler Worker

**Purpose:** Schedules all monitoring jobs.

**Responsibilities:**
- Runs on Cron Trigger every 1 minute
- Queries D1 for monitors due for execution (`last_check_at + interval_seconds <= now`)
- Invokes the correct Worker directly via Service Binding based on monitor mode:
  - external monitors → Probe Worker
  - internal OpenMetrics monitors → Scraper Worker

**Why Service Bindings instead of Queues:** Cloudflare Queues on the Free Plan are capped at 10k operations/day (≈3 ops per message lifecycle ≈ 2 monitors at 60s interval), and may require a paid plan entirely. Service Bindings are free, have no separate daily cap, and count only against the shared 100k requests/day budget.

**Fan-out limit:** A single Worker invocation can make at most 50 subrequests on the Free Plan. Each Service Binding call counts as one subrequest, so one Scheduler tick dispatches at most 50 monitors. Beyond 50 monitors, work is sharded across consecutive minute ticks (e.g. by `monitor_id` modulo). Each invoked Probe/Scraper Worker gets its own 50-subrequest budget for the actual check.

---

### Probe Worker

**Purpose:** Performs direct external checks against publicly accessible targets.

**Responsibilities:**
- Execute checks based on monitor type
- Measure latency and collect result data
- Pass results to Result Store

**Check implementations:**

| Type | Implementation |
|---|---|
| HTTP/HTTPS | `fetch()` — native Workers API |
| TCP port | `connect()` from `cloudflare:sockets` |
| SSL/TLS | SSL/TLS Inspector (see note) |
| Ping | TCP connect to port 80/443 — L4 reachability check |

**Note on SSL/TLS Inspector:** The mechanism for retrieving certificate expiry (e.g. via `fetch()` response metadata) is subject to change after PoC. The component is described abstractly to allow implementation to be determined during development.

**Note on Ping:** ICMP is unavailable in the Workers sandbox. TCP connect provides equivalent host reachability detection for uptime monitoring purposes. Packet loss is approximated via consecutive failure tracking in D1.

---

### Scraper Worker

**Purpose:** Collects OpenMetrics data from internal services accessible via Cloudflare Tunnel.

**Responsibilities:**
- Pull OpenMetrics endpoints through the tunnel
- Parse OpenMetrics format
- Extract configured metrics
- Normalize values
- Pass results to Result Store

**Supported Endpoints:**
```
/metrics
/probe
```

**Supported Exporters:**
```
blackbox_exporter
node_exporter
OpenTelemetry Collector
Grafana Alloy
custom exporters
```

---

### Result Store

**Purpose:** Centralises result persistence after each check execution.

**Responsibilities:**
- Update `monitor_state` (status, latency, timestamps, consecutive counters) — 1 write per check
- Write to `monitor_executions` **only on status change or failure** — not every check
- Write one `metric_series` row per check (metrics packed into columns, not one row per metric)

Called by both Probe Worker and Scraper Worker. Alert Evaluator runs after Result Store completes.

**Write-amplification budget (Free Plan):** D1 allows 100k writes/day. The write strategy above keeps steady-state writes to ~2 per check (state + metric_series), since `monitor_executions` writes only fire on change. See the capacity estimate under Data Storage.

---

### Alert Evaluator

**Purpose:** Converts check results into incidents. Works with state, not history.

**Responsibilities:**
- Read `monitor_state` from D1
- Open incidents after N consecutive failures
- Resolve incidents after M consecutive successes
- Prevent alert storms via cooldowns
- Deduplicate notifications for the same incident

**Example Rules:**

Open Incident: `alert_rules.failure_count` consecutive failures

Resolve Incident: `alert_rules.recovery_count` consecutive successes

Incident severity is taken from the `alert_rules.severity` that triggered the open.

---

### Notification Worker

**Purpose:** Handles notification delivery.

**Responsibilities:**
- Send alerts on incident open/resolve
- Retry failed deliveries
- Rate limiting per channel
- Delivery tracking

**Channels:**
```
Telegram
Slack
Email
Webhook
```

## Invocation Payload Contract

The Scheduler passes a single payload schema to Probe and Scraper Workers via Service Binding:

```json
{
  "monitor_id": "uuid",
  "type": "http | tcp | ssl | ping | openmetrics",
  "execution_id": "uuid",
  "scheduled_at": "ISO 8601 timestamp"
}
```

`execution_id` is generated by the Scheduler and carried through the entire execution lifecycle, linking the invocation to any `monitor_executions` record written on status change.

This contract is transport-agnostic: if the platform later moves to a paid plan and adopts Queues for durability/backpressure, the same payload becomes the queue message body with no schema change.

## Data Storage

### D1 Database

Stores operational state and execution history.

**monitors**
```
id
name
type                  -- http | tcp | ssl | ping | openmetrics
mode                  -- external | internal
scrape_url
interval_seconds
enabled
created_at
updated_at
```

**alert_rules** — evaluation rules and incident configuration for all monitor types
```
id
monitor_id
metric_name           -- nullable; used by Scraper Worker for OpenMetrics metric filtering only
condition             -- eq | gt | lt | gte | lte
threshold             -- numeric value; durations stored in seconds
severity              -- warning | critical
failure_count         -- consecutive failures required to open incident
recovery_count        -- consecutive successes required to resolve incident
cooldown_seconds      -- minimum time between repeated notifications
enabled
```

Examples:
```
metric_name: probe_success,                   condition: eq,  threshold: 0,       severity: critical
metric_name: probe_duration_seconds,          condition: gt,  threshold: 2,       severity: warning
metric_name: probe_ssl_earliest_cert_expiry,  condition: lt,  threshold: 2592000, severity: warning
metric_name: probe_ssl_earliest_cert_expiry,  condition: lt,  threshold: 604800,  severity: critical
```

For external monitors (HTTP, TCP, SSL, Ping) `metric_name` is null — the condition evaluates the check result directly.

**monitor_state** — current operational state per monitor
```
monitor_id
status                    -- up | degraded | down | unknown
last_check_at
last_success_at
consecutive_failures
consecutive_successes
active_incident_id
```

**monitor_executions** — execution history for investigation and debugging
```
id                    -- matches execution_id from invocation payload
monitor_id
started_at
completed_at
status                -- up | degraded | down
latency_ms
error
worker_region
```

**Written only on status change or failure** (not every successful check) to stay within the D1 write budget. A steady-state healthy monitor produces near-zero execution rows. Retention: last 24–48 hours, purged by the cleanup Cron job.

**incidents**
```
id
monitor_id
alert_rule_id         -- rule that opened this incident
status                -- open | resolved
severity              -- copied from alert_rules.severity at open time
started_at
resolved_at
reason
```

**notification_channels**
```
id
name
type                  -- telegram | slack | email | webhook
configuration         -- JSON: non-sensitive config only (chat_id, channel name, etc.)
secret_name           -- name of the Cloudflare Secret holding the token/credential
is_default            -- fallback channel when monitor has no explicit channels
enabled
```

`configuration` never holds tokens or credentials. `secret_name` references a Cloudflare Secret; the Notification Worker resolves the actual value from its environment (`env[secret_name]`) at send time. Secrets are never written to D1.

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

**metric_series** — platform-level time-series, one row per check
```
id
monitor_id
recorded_at
availability        -- 0 | 1
latency_ms          -- nullable
response_time_ms    -- nullable
ssl_expiry_seconds  -- nullable
tcp_connect_ms      -- nullable
```

Metrics are packed into columns of a single row (not one row per metric) to keep each check to a single insert. Raw OpenMetrics metric streams from exporters are not stored here to avoid cardinality explosion (e.g. `node_cpu_seconds_total`, `node_memory_*`).

Retention: configurable, default 30 days. A cleanup Cron job purges records older than the retention window.

**Free Plan write budget (D1: 100k writes/day):**
```
Per check:  1 monitor_state update + 1 metric_series insert = 2 writes
            (monitor_executions only on change ≈ 0 in steady state)

10 monitors × 60s interval:  10 × 1,440 × 2  =  28,800 writes/day
30 monitors × 60s interval:  30 × 1,440 × 2  =  86,400 writes/day  (near ceiling)
```
The MVP comfortably supports ~25–30 external monitors at a 60s interval. Larger fleets use longer intervals or sharding.

Used for:
- Dashboards
- Historical views
- SLA calculations
- Trend analysis

**Phase 2 upgrade path:** when Analytics Engine availability on Free Plan is confirmed or the project moves to a paid plan, `metric_series` writes can be migrated to Analytics Engine with no changes to the rest of the system — Result Store is the only write point.

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

Examples of `degraded`:
- SSL certificate expires in < 14 days
- HTTP response latency > configured threshold
- TCP connect time > configured threshold

`degraded` generates a warning incident, not a down incident. Notification channels can be configured per severity.

## OpenMetrics Model

Used exclusively by the Scraper Worker (internal monitors).

The platform evaluates a curated subset of OpenMetrics values against configured rules in `alert_rules`. Raw metric streams are not persisted.

**CPU budget note (Free Plan: 10ms CPU per invocation):** Exporters like `node_exporter` emit thousands of metric lines. Parsing the full payload can exceed the 10ms CPU limit. The Scraper Worker must parse only the metrics referenced by the monitor's `alert_rules` (filter by `metric_name` while streaming), not deserialize the entire document. Oversized payloads are capped.

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
Probe Worker. Checks: status code, response time.

### TCP Port (external)
Probe Worker uses `cloudflare:sockets connect()`. Checks: port reachability, connect latency.

### SSL/TLS (external)
Probe Worker via SSL/TLS Inspector. Checks: certificate validity, days until expiry. Implementation to be confirmed during PoC.

### Ping / Host Reachability (external)
Probe Worker uses TCP connect via `cloudflare:sockets`. Measures L4 reachability and round-trip time. No ICMP dependency.

### OpenMetrics (internal, via Cloudflare Tunnel)
Scraper Worker fetches `/metrics` or `/probe`. Evaluates a configured subset of metrics against threshold rules.

## Alerting Flow

```
Check Result (Probe Worker or Scraper Worker)
        |
        v
Result Store
  - update monitor_state            (1 write)
  - write metric_series             (1 write)
  - write monitor_executions        (only on status change)
        |
        v
Alert Evaluator  (reads D1 state only)
        |
        +-- consecutive_failures >= threshold  -->  open incident (down or degraded)
        |
        +-- consecutive_successes >= threshold  -->  resolve incident
        |
        v  Service Binding (only on incident open/resolve)
        |
Notification Worker
        |
        +-- Telegram
        +-- Slack
        +-- Email
        +-- Webhook
```

## Cloudflare Free Plan Constraints

The platform is designed to run entirely within the Cloudflare Free Plan.

| Product | Free Limit | Usage |
|---|---|---|
| Workers | 100k requests/day | Scheduler, Probe, Scraper, Notification Workers |
| Workers | 10ms CPU/invocation | Bounds OpenMetrics parsing — filter, don't full-parse |
| Workers | 50 subrequests/invocation | Bounds Scheduler fan-out to 50 monitors/tick |
| Cron Triggers | 5 per account | Scheduler (1), cleanup (1) — 3 remaining |
| D1 | 5M reads/day, 100k writes/day, 5GB | All data; ~2 writes/check → ~30 monitors at 60s |
| Service Bindings | Free, no daily cap | Hot-path fan-out and notifications (replaces Queues) |
| R2 | 10GB, 1M ops/month | Optional, not required for MVP |

**Queues are not used in the MVP.** Queues are available on the Free Plan (added Feb 2026) but capped at 10k operations/day. At ~3 operations per message lifecycle (write + read + delete), that supports only ~2 monitors at a 60s interval — unusable for the hot path. The hot path uses Service Bindings instead. Queues remain an upgrade for durability and backpressure (the invocation payload is already queue-compatible).

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
  - name: telegram-main
    type: telegram
    is_default: true
    chat_id: "123456"                    # non-sensitive, stored in D1
    secret_name: TELEGRAM_BOT_TOKEN      # name only; value lives in Cloudflare Secrets

monitors:
  - name: public-api
    type: http
    mode: external
    target: https://api.example.com/health
    interval: 60s

    alerts:
      - condition: "status != 200"
        severity: critical
        failures: 3
        recovery: 2
        cooldown: 300s
      - condition: "latency > 2000"
        severity: warning
        failures: 3
        recovery: 2

    notifications:
      - channel: telegram-main
        notify_on: [incident_open, incident_resolved]

  - name: internal-db
    type: openmetrics
    mode: internal
    target: https://tunnel.example.internal/metrics
    interval: 30s

    alerts:
      - metric: probe_success
        condition: "== 0"
        severity: critical
        failures: 2
        recovery: 2
```

### Secrets

Sensitive values (tokens, webhook URLs, credentials) live exclusively in Cloudflare Secrets bound to the Workers. They never appear in `config.yaml` and are **never written to D1**.

The flow is reference-only:
```
config.yaml         secret_name: TELEGRAM_BOT_TOKEN     (just a name)
      |
      v
D1                  notification_channels.secret_name = "TELEGRAM_BOT_TOKEN"
      |
      v
Worker (runtime)    value = env["TELEGRAM_BOT_TOKEN"]   (resolved from Cloudflare Secrets)
```

The import step writes only the secret name into D1. The actual value is resolved by the Notification Worker from its environment at send time. A D1 dump therefore contains no credentials.

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

### MVP (Free Plan)
- External probing: HTTP, TCP, SSL, Ping (TCP-based)
- Internal OpenMetrics scraping via Cloudflare Tunnel
- blackbox_exporter support
- Service Binding fan-out (no Queues)
- Incident management (down + degraded)
- Telegram notifications
- Webhook notifications
- D1 storage (state, executions, metric_series)

### Phase 2
- Maintenance Windows
- Tags
- Monitor Groups
- Monitor Dependencies
- Public Status Pages
- Multi-region probing
- Migrate `metric_series` to Analytics Engine when monitor count nears the D1 write ceiling (~30 at 60s) — frees ~half of D1 writes, ~doubles capacity to ~60 monitors
- Adopt Queues for durable fan-out and backpressure once monitor volume justifies the per-message operation cost

### Deferred
- User accounts
- RBAC
- Multi-tenancy
- OpenTelemetry traces
- Distributed agents

## Design Principles

- External probing runs natively in Workers — no external probe agents.
- Internal services are reached exclusively via Cloudflare Tunnel.
- TCP connect is the reachability primitive; ICMP is not required.
- OpenMetrics is the integration format for internal exporters.
- Alert Evaluator works with operational state (D1), not with metrics history.
- All data lives in D1: operational state, execution history (`monitor_executions`), and time-series (`metric_series`). No raw exporter metrics are persisted.
- The hot path uses Service Bindings, not Queues — Queues do not fit the Free Plan and are a paid-plan upgrade.
- Writes are minimised: `monitor_state` + one `metric_series` row per check; `monitor_executions` only on status change.
- The MVP must run entirely within Cloudflare Free Plan limits.
- Additional Cloudflare services should only be introduced when they solve a demonstrated scaling problem.
- Alerting is incident-based, not check-based. Severity and thresholds are defined in `alert_rules`.
- Notifications are asynchronous. Delivery state is tracked in `notification_deliveries`.
- Notification routing: per-monitor channels take precedence; default channels are the fallback.
- Queue payload carries `execution_id` from scheduling through to storage.
- Configuration is defined in YAML (version-controlled) and imported into D1 via CI/CD. Workers never read YAML.
- Secrets live only in Cloudflare Secrets. D1 stores the secret *name*; Workers resolve the value from their environment at runtime. Secrets never touch `config.yaml` or D1.
