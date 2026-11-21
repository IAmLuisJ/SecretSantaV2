# Contributing

Start with the [quickstart](QUICKSTART.md) for local setup and a two-person exchange you can use to try changes.

## Project layout

| Path | Purpose |
| --- | --- |
| [`app/routes/`](app/routes/) and [`app/ui.tsx`](app/ui.tsx) | Route loaders and actions, and shared React UI. |
| [`app/server/`](app/server/) | Authentication, exchange and draw rules, gifts, Elf Mail, and email delivery. |
| [`workers/app.ts`](workers/app.ts) and [`cloudflare.config.ts`](cloudflare.config.ts) | Worker entry point, scheduled tasks, and Cloudflare bindings. |
| [`migrations/`](migrations/) | Ordered D1 schema migrations. |
| [`tests/`](tests/) and [`tests/e2e/`](tests/e2e/) | Vitest suites and Playwright browser flows. |

## Run checks

From the repository root after `npm ci`, run TypeScript checks, Vitest, and a Worker build with local bindings.

```sh
npm run typecheck
npm test
npm run build
```

Install the Playwright browsers, then run both sign-in modes as CI does.

```sh
npx playwright install chromium webkit
SANTA_EMAIL_SIGN_IN_ENABLED=true npm run test:e2e
SANTA_EMAIL_SIGN_IN_ENABLED=false npm run test:e2e
```

Playwright starts its own dev server on `127.0.0.1:5197` by default and applies migrations to a disposable Miniflare D1 database. It generates a test auth secret and records local mail in `.cloudflare/e2e-mail-5197.log`. Set `SANTA_LOCAL_PORT` if that port is busy. The `Mobile Chrome` and `Mobile WebKit` projects use mobile device profiles.

## Open a pull request

1. Create a branch from `main` and keep the change focused. Use synthetic data and `.test` addresses for fixtures, screenshots, and bug reports. Keep `.dev.vars`, credentials, and mail logs local.
2. For schema changes, add a new numbered SQL file in `migrations/`. Keep applied migrations intact and verify the change on a fresh local database and an existing one. The local migration command is `npm run db:local`.
3. Update the docs in the same PR. Update the [README](README.md) when features or deployment change, the [quickstart](QUICKSTART.md) when setup or the first exchange changes, and this guide when checks or contributor workflows change.
4. Open the PR against `main` with a brief summary, the checks you ran, and screenshots for visible changes. The [CI/CD workflow](.github/workflows/ci-cd.yml) runs TypeScript, Vitest, and both browser suites, and uploads Playwright reports for failures.
