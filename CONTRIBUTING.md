# Contributing

Thanks for your interest in improving heartbeatflare! Contributions of all
kinds — bug reports, fixes, docs, and features — are welcome.

## Getting started

```sh
git clone https://github.com/HSGiGa/heartbeatflare.git && cd heartbeatflare
npm ci
cp .env.example .env   # local-only; never commit real credentials
npm test               # Vitest with the Workers runtime
npm run dev            # local Worker at http://localhost:8787
```

## Development workflow

1. Create a branch off `main`.
2. Make your change with a matching test where it makes sense.
3. Run the full check suite locally before opening a PR:

   ```sh
   npm test
   npm run typecheck:scripts
   npx tsc -p tsconfig.json
   npm run migration:lint
   ```

4. Open a pull request describing the change and the motivation.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entry point — dispatches fetch / scheduled / queue |
| `src/scheduler.ts` | Cron tick: select due monitors, probe, detect missed heartbeats, rollup, cleanup |
| `src/probes.ts` | HTTP, TCP, DNS and SSL-expiry probe implementations |
| `src/heartbeat.ts` | Heartbeat ingest endpoint (`POST /beat/<id>/<token>`) |
| `src/alerts.ts` | Result store (write-budget aware) + alert evaluation + incidents |
| `src/queue.ts` / `src/notify.ts` | Notification delivery and channel resolution |
| `src/routes.ts` | HTTP routing, edge caching, JSON API, feed + badge endpoints |
| `src/status-page.ts` | Server-rendered status page (uptime bars, sparklines, maintenance) |
| `src/feed.ts` | Atom feed builder (`/feed.xml`) |
| `src/badge.ts` / `src/status-meta.ts` | SVG status badge + shared status→label/colour mapping |
| `src/auth.ts` | Cloudflare Access JWT verification (fail-closed) |
| `src/usage.ts` | Account usage block (Cloudflare GraphQL API) |
| `scripts/` | Provisioning, config import and secret sync (deploy-time, Node) |
| `migrations/` | D1 schema migrations (additive-only) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how these fit together.

## Guidelines

- **Database migrations are additive-only.** No `DROP`/`RENAME` of tables or
  columns — `migration:lint` enforces this. Removing a monitor from
  `config.yaml` soft-disables it; history is preserved.
- **Never commit secrets.** Use `${VAR}` placeholders in `config.yaml`; values
  live in `.env` (git-ignored) and Cloudflare Worker Secrets. See
  [SECURITY.md](SECURITY.md).
- **Keep `config.yaml` portable.** No private hostnames, account IDs, or real
  credentials in committed config — use neutral example values
  (`status.example.com`, `api.example.com`).
- **Match the existing code style.** Prettier config is in `.prettierrc`;
  follow the conventions of the surrounding code.
- **Mind the free-plan budgets.** The design targets the Cloudflare free tier
  (D1 write budgets, subrequest limits, edge caching). See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Reporting bugs

Open an issue at
https://github.com/HSGiGa/heartbeatflare/issues with reproduction steps and
your environment. For security issues, follow [SECURITY.md](SECURITY.md)
instead of filing a public issue.
