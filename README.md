# Secret Santa V2

A mobile-first gift exchange for friends and family. Create a group, share its invite, and run a fresh exchange each year. The draw enforces mutual couple exclusions and skips each giver's recipient from the last completed exchange.

## Run locally

Use Node.js 22.22 or later.

```sh
npm ci
(umask 077; printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > .dev.vars)
npm run db:local
npm run dev
```

Open [the local app](http://127.0.0.1:5173/). The Worker uses local D1 and R2, and prints synthetic sign-in codes to the dev terminal. Use addresses ending in `.test`. The dev server accepts the configured loopback origin, so use `127.0.0.1` in the address bar.

## Checks

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

The automated checks use loopback networking and local Cloudflare emulators. The browser suite creates its own disposable database and uses synthetic email addresses. Its local mail log lives under the ignored `.cloudflare/` directory. The build command exercises the production bundler with local bindings.

## Staging and production

Use separate Cloudflare D1 databases, private R2 buckets, HTTPS Worker custom domains, and auth secrets. Verify the Resend sender domain before using the real delivery path. Store the following configuration in the release environment.

| Setting | Value |
| --- | --- |
| `SANTA_APP_ORIGIN` | HTTPS origin without a trailing slash |
| `SANTA_D1_ID` | D1 database UUID for this environment |
| `SANTA_R2_BUCKET` | Private R2 bucket name for this environment |
| `SANTA_MAIL_FROM` | Verified Resend sender address |
| `BETTER_AUTH_SECRET` | Worker secret with at least 32 bytes of randomness |
| `RESEND_API_KEY` | Worker secret for sending transactional email |

After creating the staging bindings, apply the migrations and build with the matching mode. Put the two Worker secrets in a protected dotenv file outside the checkout or supply it through your CI secret store.

```sh
npx cf d1 migrations apply "$SANTA_D1_ID" --dir migrations
npx vite build --mode staging
npx cf deploy --prebuilt --mode staging --secrets-file /absolute/path/to/staging-secrets.env
```

Run the invite, sign-in, wish upload, draw, and completion flows with controlled staging accounts. Check real email delivery and Worker CPU usage, and run the primary flow on physical iOS Safari and Android Chrome. Repeat with the separate production bindings and `production` build mode after staging passes. Keep the image bucket private.

If replacing an older Secret Santa installation, start V2 with an empty database. Verify a private backup of the old installation before disabling it. Redirect the old join URL to `/expired-invite` without forwarding legacy query parameters.

## License

[MIT](LICENSE)
