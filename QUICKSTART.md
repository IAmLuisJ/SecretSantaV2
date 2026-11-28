# Quickstart

Run Secret Santa V2 locally and unwrap a test match. The commands use a POSIX shell, Node.js 22.22.0 or later, npm, and OpenSSL. Local development uses emulated Cloudflare D1 and R2 and logs email in the terminal, so you can start without Cloudflare or Resend credentials.

## Start the app

1. From the repository root, run `npm ci`.
2. On first setup, create `.dev.vars` with a generated auth secret. Keep your existing `.dev.vars` if you've already set one up. See [`.dev.vars.example`](.dev.vars.example) for the file format.

   ```sh
   (umask 077; set -C; printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" > .dev.vars)
   ```

3. Apply the D1 migrations and start the dev server. Confirm the local migration if the CLI prompts you.

   ```sh
   npm run db:local && npm run dev
   ```

4. Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). Use `127.0.0.1` so the URL matches the configured sign-in origin.

## Run a test exchange

1. Enter `organizer@example.test` and select **Send sign-in code**. Find the six-digit code in the `[local mail]` entry for that address in the dev terminal. Enter it and select **Verify code**.
2. Enter a group name and your display name, keep or set the exchange year, and select **Create group**. Under **Invite your people**, select **Copy link**.
3. Open the invitation link in a private window or a second browser profile. Sign in with `guest@example.test`, enter a display name, and select **Join group**. Under **My wish list**, choose **Add a wish**, enter an item name, and select **Add wish**.
4. Refresh the organizer's dashboard to load the new member. In **Organizer tools**, check that both adults are on the roster. Leave **Draw Party release time** blank and select **Draw names** to release matches immediately.
5. Select **Unwrap match** in each session. The organizer should see the guest's name and wish. To try **Elf Mail**, send a prompt from the organizer's match card, then refresh the guest's dashboard and reply from the **Elf Mail inbox**.

To try a countdown, set a future **Draw Party release time** in your browser's local time before drawing. Participants can unwrap their matches when the countdown ends.

Use **My exchanges** in the header to switch groups and **Account** to manage your sign-in.

## Try a shared wish list

1. Add a wish under **My wish list**, keeping **Show this wish in** set to **All my exchanges**. Create or join another exchange with the same account: the wish appears there too. Select **Only this exchange** to keep an individual wish in one group.
2. After each exchange's draw is released, an assigned giver can mark the shared wish purchased. Other assigned givers see the same status; the wish's owner does not see it. Open **Change sharing** on your own wish to change its scope later.
3. Add a child under **Little Ones** and add a shared wish for them. In another exchange, select **Use an existing Little One**, choose that child, and select **Use this Little One**. Marking the shared wish purchased updates it in both exchanges. Wishes marked **Only this exchange** stay with their group.

Wishes that existed before the sharing upgrade stay exchange-specific until explicitly shared. For older Little Ones, use **Use this list in other exchanges** → **Manage shared list** first to manage sharing and make the child available in your other exchanges.

## Try password sign-in

Stop the dev server and restart it with email-code sign-in disabled.

```sh
SANTA_EMAIL_SIGN_IN_ENABLED=false npm run dev
```

In a signed-out session, select **Create an account** and register with an unused `.test` address. You can then create a group or follow an invitation link.

## Troubleshooting

- If the app reports a missing database table, stop the server, run `npm run db:local`, and start it again.
- If port `5173` is in use, run `SANTA_LOCAL_PORT=5174 npm run dev` and open [http://127.0.0.1:5174/](http://127.0.0.1:5174/).

For automated checks and pull requests, see [Contributing](CONTRIBUTING.md).
