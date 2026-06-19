# Roadmap

This document collects planned work that is not part of the current heartbeatflare runtime. It is
not a release schedule or a commitment. Priorities depend on operational need, Cloudflare product
limits and maintainer capacity.

For the implemented design, see [Architecture](docs/ARCHITECTURE.md).

## Monitoring and Status

### Degraded monitor status

Today the probe path writes `up` or `down` to `monitor_state.status`. Warning conditions, such as
SSL certificate expiry, open warning incidents without changing that status.

A future degraded state could represent:

- SSL certificate nearing expiry
- HTTP latency above a configured warning threshold
- TCP connect time above a configured warning threshold

### Components and richer status pages

Potential status-page improvements:

- component groups and dependencies
- subscriptions and email updates
- multiple status pages
- custom incident messages
- SLA reporting and uptime charts
- a dedicated status-page API

## Metrics and Storage

### OpenMetrics for internal services

Potential design: scrape `/metrics` or `/probe` through Cloudflare Tunnel and evaluate a curated
subset of OpenMetrics values against configured alert rules. Raw metric streams would not be stored
without a demonstrated use case.

Cloudflare Workers have a tight CPU budget. A scraper would need to:

- parse only metrics referenced by configured alert rules,
- filter by metric name while streaming,
- avoid deserializing the complete exporter response,
- cap oversized payloads.

Examples of relevant blackbox-exporter metrics:

```text
probe_success
probe_duration_seconds
probe_http_status_code
probe_ssl_earliest_cert_expiry
probe_tcp_connect_duration_seconds
```

### Analytics Engine for raw metrics

The current implementation stores actionable raw samples in D1. Revisit Analytics Engine when the
D1 write ceiling becomes the practical constraint, around 30 monitors at 60-second intervals.

A migration of `metric_series` could:

- remove roughly half of D1 writes,
- increase practical monitor capacity,
- keep the change localized because Result Store is the only raw-metric write point.

Before making that change, confirm the relevant Cloudflare plan limits and account requirements.

### Optional R2 storage

Potential uses include raw OpenMetrics payloads, debug snapshots, audit archives and incident
evidence. R2 is not required by the current runtime.

## Operations and Scale

### Manual incident workflows

Potential operator features:

- manual incidents
- incident acknowledgement
- incident update timeline (investigating, identified, resolved)

### Multi-tenant and multi-region monitoring

heartbeatflare is currently a single-account, self-hosted deployment. Possible future directions:

- multi-tenancy with an additive `account_id` model
- multi-region probing

Multi-region probing needs careful storage design because adding a region dimension to
`monitor_state` and uptime aggregate keys later may require a table rebuild.

## Design Constraint

New Cloudflare services should be introduced only when there is a demonstrated scaling or product
need. The current design favors one Worker, D1 and Queues because that keeps deployment, local
development and operational reasoning straightforward.
