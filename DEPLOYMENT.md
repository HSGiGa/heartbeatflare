# Cloudflare Deployment

This project supports three production deployment paths:

- local CLI
- GitHub Actions
- GitLab CI

The CLI path is intentionally independent from GitHub and GitLab. CI uses the same Wrangler commands as the CLI path.

## Required Cloudflare Variables

Create a Cloudflare API token with permissions for Workers deployment and D1 management, then provide:

```sh
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

For local CLI usage, either export the variables in your shell or copy `.env.example` to `.env` and load it before running npm scripts:

```sh
set -a
. ./.env
set +a
```

`.env` is ignored by git.

For GitHub Actions, add repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

For GitLab CI, add protected and masked CI/CD variables:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

## One-Time D1 Setup

Create the production D1 database:

```sh
npm run d1:create:prod
```

Copy the returned database UUID into `wrangler.jsonc`:

```jsonc
"database_id": "REPLACE_WITH_HEARTBEATFLARE_PROD_DB_ID"
```

## CLI Deployment

Install dependencies:

```sh
npm ci
```

Verify Cloudflare authentication:

```sh
npm run cf:whoami
```

Apply remote D1 migrations:

```sh
npm run d1:migrate:prod
```

Deploy the Worker to `workers.dev`:

```sh
npm run deploy
```

Or run the combined production flow:

```sh
npm run deploy:prod
```

## CI Deployment

GitHub Actions deploys on:

- push to `main`
- manual `workflow_dispatch`

GitLab CI deploys on:

- default branch pipeline
- manual web pipeline

Both CI paths run:

```sh
npm ci
npm run test
npm run d1:migrate:prod
npm run deploy
```

## Verification

List D1 migrations:

```sh
npx wrangler d1 migrations list heartbeatflare-prod-db --remote
```

List D1 tables:

```sh
npx wrangler d1 execute heartbeatflare-prod-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

After deploy, fetch the `workers.dev` URL printed by Wrangler. The current placeholder Worker returns:

```text
Hello World!
```
