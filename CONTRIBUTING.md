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
