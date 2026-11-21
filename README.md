# Secret Santa V2

A mobile-first gift exchange for friends and family. Create a group, invite your people, and reuse the group for a new exchange each year.

[Run your first local exchange](QUICKSTART.md) · [Contributing](CONTRIBUTING.md) · [Deployment](#deployment)

## How an exchange works

- Share an invitation link or group code. One account can organize some groups and participate in others. Switch between them in **My exchanges**.
- Maintain a wish list with links and photos, and add a mailing address if you want your assigned giver to have it. **Little Ones** gives the group a shared list for children's wishes and lets members track purchases separately from the adult draw.
- The organizer sets the adult roster and can block pairs in both directions. Each adult on the roster gives and receives once. The draw rules exclude self-matches and each giver's recipient from the last completed exchange.
- Publish matches immediately or set a **Draw Party** release time. The dashboard counts down and keeps match details private until release. Each participant can then select **Unwrap match** to see their own recipient and the recipient's wishes.
- Enable **codename mode** before the first draw to show nicknames for matches and hide mailing addresses. Participants can label gifts with their match's codename.
- With **Elf Mail**, givers can send preset prompts or custom questions from their match card. Recipients reply in their Elf Mail inbox, where the giver appears as **Your Secret Santa**. Messages stay within the matched pair for the current released draw. A redraw starts fresh conversations.
- **Guess Your Santa** is an optional game for each season. Once the draw is released, participants can lock one private guess after opening their gift. Redraws are allowed until the first guess is locked or the organizer reveals the pairings. **Reveal Santas** closes guessing and shares the real-name pairings and guess outcomes with participants, even in codename mode.

After the draw is released, the organizer can complete the exchange and start a later season in the same group. The next roster starts with the adults from the last completed draw and can be edited before drawing again.

## Sign-in and account settings

Email sign-in uses a six-digit code when mail delivery is configured and email-code sign-in is enabled. Existing password users can select **Sign in with a password**. The app offers password registration when email-code sign-in is turned off or mail configuration is missing.

Open **Account** to change your sign-in email by confirming a code sent to the new address. You can also merge a second account you control into your signed-in account. Authenticate the other account with its password or, when email-code sign-in is available, a code sent to its verified address. The merge preserves its exchanges, organizer roles, wishes, and draw history, then closes the other account. The two accounts must belong to different groups.

## Deployment

The React Router app runs on a Cloudflare Worker. D1 stores exchange data, a private R2 bucket stores wish photos, and Resend delivers email. The Worker processes queued mail and cleans up unused photos every two minutes.

### Cloudflare and Resend settings

Provision separate D1 databases, private R2 buckets, Worker custom domains, and auth secrets for staging and production. Verify the sender domain in Resend. [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction)

| Setting | GitHub Actions environment | Value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID for the deployment. |
| `CLOUDFLARE_API_TOKEN` | Secret | Token scoped to the account and domain, with access to deploy the Worker and its custom domain and apply D1 migrations. |
| `SANTA_APP_ORIGIN` | Variable | HTTPS Worker origin without a trailing slash. |
| `SANTA_D1_ID` | Variable | D1 database UUID. |
| `SANTA_R2_BUCKET` | Variable | Private R2 bucket name. |
| `SANTA_MAIL_FROM` | Variable | Sender address on a verified Resend domain. |
| `BETTER_AUTH_SECRET` | Secret | Worker secret generated from at least 32 random bytes. Reuse the existing secret for a live environment. |
| `RESEND_API_KEY` | Secret | Worker secret for sending transactional email. |

### Production on GitHub Actions

Create a GitHub Actions environment named `production`, restrict deployments to `main`, and add the settings above. [Cloudflare CLI credentials](https://developers.cloudflare.com/cf/ci/#provide-credentials)

Pull requests run TypeScript, Vitest, and Playwright. Playwright tests email and password flows in Chromium and WebKit using mobile device profiles. Failed browser runs upload reports with traces. Pushes to `main`, including merges, rerun the checks. The deploy job then builds and validates the production Worker, checks that the revision is still at the tip of `main`, applies pending D1 migrations, and deploys. [CI/CD workflow](.github/workflows/ci-cd.yml)

To deploy through checked pull requests, configure a `main` branch ruleset that requires pull requests and the **Vitest**, **Playwright (email)**, and **Playwright (password)** checks.

### Manual staging deploy

After `npm ci`, export the staging variables from the table and the staging `CLOUDFLARE_API_TOKEN` in your shell. Put `BETTER_AUTH_SECRET` and `RESEND_API_KEY` in a private JSON or dotenv file outside the checkout. Build and validate before applying the migrations and deploying the same build.

```sh
npx vite build --mode staging &&
  npx cf deploy --prebuilt --mode staging --dry-run &&
  npx cf d1 migrations apply "$SANTA_D1_ID" --dir migrations &&
  npx cf deploy --prebuilt --mode staging --secrets-file /absolute/path/to/staging-secrets.env
```

The production workflow uses email-code sign-in by default. Set `SANTA_EMAIL_SIGN_IN_ENABLED=false` when running a manual build to use password registration and sign-in. With Resend configured, the Worker can still send email invitations and verify changes to sign-in addresses.

Run the invite, sign-in, wish upload, draw, and completion flows with controlled staging accounts. Check real email delivery and Worker CPU usage, and try the primary flow on iOS Safari and Android Chrome. For a manual production deploy, use the production resources and `production` mode for both build and deploy.

### Upgrading from the original Secret Santa

If replacing an older Secret Santa installation, start V2 with an empty database. Verify a private backup of the old installation before disabling it. Redirect the old join URL to `/expired-invite` without forwarding legacy query parameters.

## License

[MIT](LICENSE)
