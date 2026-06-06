# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**heartbeatflare** is a Cloudflare Workers application built with TypeScript. It's a minimal, production-ready edge worker that handles HTTP requests globally across Cloudflare's network. The project is currently a "Hello World" starter but designed to scale into full APIs, webhooks, data processors, and microservices.

## Common Commands

### Development
- `npm run dev` - Start local development server (http://localhost:8787)
- `npm run test` - Run test suite with Vitest
- `npm run test -- --watch` - Run tests in watch mode
- `npm run test -- src/` - Run tests for specific module

### Deployment & Configuration
- `npm run deploy` - Deploy Worker to Cloudflare (requires Wrangler login)
- `npm run cf-typegen` - Regenerate TypeScript types for bindings after modifying `wrangler.jsonc`

### Debugging
- Use `npm run dev` to access the local Worker at `http://localhost:8787` with auto-reload
- Add `console.log()` statements; output appears in the terminal and Cloudflare dashboard
- Check `wrangler.jsonc` settings - Observability is enabled for monitoring

## Architecture & Code Structure

### Entry Point: `src/index.ts`
- Single file containing the Worker handler (pattern: `ExportedHandler<Env>`)
- Receives all HTTP requests via the `fetch()` function
- Receives three parameters:
  - `request`: The incoming HTTP Request
  - `env`: Environment with bindings (databases, KV stores, secrets, variables)
  - `ctx`: Execution context for background tasks and caching

**Current Implementation**: Returns a static "Hello World!" response. Ready to extend with routing, middleware, and business logic.

### Testing: `test/index.spec.ts`
- Uses Vitest + `@cloudflare/vitest-pool-workers` for realistic Workers testing
- **Unit Tests**: Direct handler invocation with mocked environment
- **Integration Tests**: Real request simulation using the `SELF` binding
- Type-safe test environment (`env.d.ts` auto-generated)

**Pattern**: Tests demonstrate both isolation and integration approaches. Add new test cases as features are implemented.

### Configuration Files

**`wrangler.jsonc`** (Cloudflare Workers Configuration)
- `main`: Points to `src/index.ts`
- `compatibility_date`: "2025-06-07" (pins JavaScript API version)
- `observability.enabled`: true (enables monitoring)
- Commented-out sections for optional features:
  - Smart Placement (global edge optimization)
  - Bindings (D1 Database, R2 Object Storage, AI, KV, etc.)
  - Environment variables and secrets
  - Static assets serving
  - Service bindings for multi-Worker communication

**`tsconfig.json`**
- Strict mode enabled for type safety
- Target: ES2021
- Module system: ES2022 with bundler resolution
- `noEmit: true` - Type checking only; Wrangler handles bundling

**`vitest.config.mts`**
- Configured for Workers-specific testing via the Cloudflare pool
- Reads from `wrangler.jsonc` during test execution

### Code Quality & Style
- **Formatting**: Prettier (140 char width, single quotes, tabs, semicolons)
- **EditorConfig**: Tab indentation, LF line endings, UTF-8 charset

## Adding Features

### Adding Bindings (Database, KV Store, etc.)
1. Uncomment or add binding in `wrangler.jsonc` (see Cloudflare docs for syntax)
2. Run `npm run cf-typegen` to regenerate the `Env` type
3. Use the binding in `src/index.ts` via `env.MY_BINDING`
4. Add tests for the new binding interaction in `test/index.spec.ts`

### Adding Routes/Routing
The current handler is request-agnostic. To add routing:
- Parse `request.method` (GET, POST, etc.)
- Parse `request.url` for path matching
- Consider adding a routing library (e.g., `hono`, `itty-router`) or simple if/switch logic
- Each route handler should be testable separately

### Adding Environment Variables/Secrets
- Variables: Add to `vars` in `wrangler.jsonc`, access via `env.MY_VAR`
- Secrets: Define in Cloudflare dashboard (not in code), access via `env.MY_SECRET`
- Run `npm run cf-typegen` after adding to regenerate types

### Writing D1 Migrations

- Migrations live in `migrations/` and run via `npx wrangler d1 migrations apply heartbeatflare-prod-db --remote`
- Each migration file runs exactly once; there is no rollback — design schemas to be additive
- **Always include a backfill when adding a derived/aggregate table.** If the new table is computed from existing data, add `INSERT INTO … SELECT …` in the same migration file so existing rows are populated immediately and no historical data is silently lost:

```sql
-- Example: new aggregate table with backfill
CREATE TABLE uptime_daily ( … );

INSERT INTO uptime_daily (monitor_id, day, total_checks, up_checks, avg_latency_ms)
SELECT monitor_id, DATE(recorded_at), COUNT(*), SUM(availability), AVG(NULLIF(latency_ms, 0))
FROM metric_series
GROUP BY monitor_id, DATE(recorded_at);
```

### Deploying to Production
- Ensure all tests pass: `npm run test`
- Run `npm run deploy` (requires `wrangler login`)
- Verifies configuration and deploys to `heartbeatflare.<your-account>.workers.dev`
- Changes are live globally within seconds

## Project Philosophy

**Minimal by design**: No unnecessary dependencies. Workers are faster and cheaper when lightweight.

**Type-first**: TypeScript catches errors at compile time. Strict mode prevents runtime surprises.

**Edge-native**: Built for global distribution from day one. Think in terms of low latency, distributed state, and edge caching.

**Test-driven**: Integration tests verify real Worker behavior under the Workers runtime.

**Scalable from simple**: Grows from a webhook handler to a complex API gateway without architectural changes.

## Resources
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)
- [Vitest Documentation](https://vitest.dev/)
