# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, report vulnerabilities privately via GitHub's
[private vulnerability reporting](https://github.com/HSGiGa/heartbeatflare/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

When reporting, please include:

- a description of the vulnerability and its impact;
- steps to reproduce or a proof of concept;
- affected version / commit, if known.

You can expect an initial response within a few days. Once a fix is available,
we will coordinate a disclosure timeline with you.

## Scope

heartbeatflare is a self-hosted Cloudflare Worker. Reports about the code in
this repository are in scope. Misconfiguration of your own deployment
(leaked API tokens, overly broad Cloudflare Access policies, exposed
`.env` files, etc.) is out of scope — see the deployment docs for hardening
guidance.

## Handling secrets

Secrets (API tokens, webhook URLs, bot tokens) must never be committed. They
belong in `.env` (git-ignored) locally and in CI secrets / Cloudflare Worker
Secrets in production, referenced from `config.yaml` only via `${VAR}`
placeholders. If you believe a secret has been committed, treat it as
compromised and rotate it immediately.
