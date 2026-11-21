import { data, Link, redirect } from "react-router";
import type { Route } from "./+types/account";
import { workerContext } from "../context";
import { maxPasswordLength } from "../password";
import { AccountError, confirmAccountCode, mergeWithPassword, sendAccountCode, type EmailOperation } from "../server/account";
import { emailSignInEnabled, normalizeEmail } from "../server/auth";
import { GiftError } from "../server/gifts";
import { readForm, requestOrigin, signedInSession } from "../server/http";
import { mailAvailable } from "../server/mail";
import { ActionForm, EntryHero, Feedback, Submit } from "../ui";

type Mode = EmailOperation | "merge-password";
type AccountFormResult = { mode: Mode; email?: string; challenge?: string; error?: string };

function accountMode(url: URL): Mode | null {
  const mode = url.searchParams.get("mode");
  return mode === "change-email" || mode === "merge-accounts" || mode === "merge-password" ? mode : null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const actor = await signedInSession(request, env);
  if (!actor) return redirect("/");
  const url = new URL(request.url);
  const updated = url.searchParams.get("updated");
  return {
    email: actor.user.email,
    mode: accountMode(url),
    canChangeEmail: mailAvailable(env, origin),
    canMergeWithCode: emailSignInEnabled(env, origin),
    message: updated === "email" ? "Email address updated." : updated === "merge" ? "Accounts merged." : undefined,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const actor = await signedInSession(request, env);
  if (!actor) return redirect("/", 303);
  const mode = accountMode(new URL(request.url));
  if (!mode) throw new Response(null, { status: 400 });
  const fields: AccountFormResult = { mode };

  try {
    const form = await readForm(request, origin);
    const intent = form.get("intent");
    fields.email = normalizeEmail(form.get("email")) ?? undefined;
    const challenge = form.get("challenge");
    if (typeof challenge === "string" && /^[a-f0-9-]{36}$/.test(challenge)) fields.challenge = challenge;

    if (mode === "merge-password" && intent === "merge-password") {
      await mergeWithPassword(request, env, actor, fields.email, form.get("password"));
    } else if (mode !== "merge-password" && (intent === "send-code" || intent === "verify-code")) {
      if (mode === "merge-accounts" && !emailSignInEnabled(env, origin)) {
        throw new AccountError("Email verification is unavailable right now. Use the other account’s password.", 503);
      }
      if (intent === "send-code") {
        const challenge = await sendAccountCode(request, env, actor, mode, fields.email);
        return { ...fields, challenge };
      }
      await confirmAccountCode(env, actor, mode, fields.challenge, form.get("code"));
    } else {
      throw new Response(null, { status: 400 });
    }
    return redirect(mode === "change-email" ? "/account?updated=email" : "/account?updated=merge", 303);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof AccountError) {
      const startOver = error.status === 409 || error.status === 503;
      return data({ ...fields, challenge: startOver ? undefined : fields.challenge, error: error.message }, { status: error.status });
    }
    if (error instanceof GiftError) return data({ ...fields, error: error.message }, { status: 400 });
    console.error("Account update failed.");
    return data({ ...fields, error: "We couldn’t update your account right now. Try again in a moment." }, { status: 500 });
  }
}

export default function AccountSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { email, mode, canChangeEmail, canMergeWithCode, message } = loaderData;
  const result = actionData?.mode === mode ? actionData : undefined;
  const changingEmail = mode === "change-email";
  const usingPassword = mode === "merge-password";
  const canUseMode = changingEmail ? canChangeEmail : usingPassword || canMergeWithCode;
  const action = `/account?mode=${mode}`;
  const mergeLink = canMergeWithCode ? "/account?mode=merge-accounts" : "/account?mode=merge-password";

  return (
    <div className="entry">
      <EntryHero title="Account settings" />
      <section className="entry-paper" aria-label="Manage your account">
        <p className="account-email">Signed in as <strong>{email}</strong></p>
        <Feedback error={result?.error} message={message} />
        {!mode ? (
          <div className="account-options">
            {canChangeEmail
              ? <Link className="button button-secondary" to="/account?mode=change-email">Change email</Link>
              : <p className="section-note">Changing your email requires email delivery.</p>}
            <Link className="button button-secondary" to={mergeLink}>Merge accounts</Link>
          </div>
        ) : (
          <>
            <h2>{changingEmail ? "Change email" : "Merge accounts"}</h2>
            {canUseMode && <p>{changingEmail
              ? "Confirm the address you want to use for sign-in and exchange emails."
              : "Move the other account’s exchanges here and close the other account."}</p>}
            {!canUseMode ? (
              changingEmail ? <p>Changing your email requires email delivery.</p>
                : <Link className="button button-secondary" to={mergeLink}>Use the other account’s password</Link>
            ) : result?.challenge ? (
              <>
                <p>Enter the six-digit code sent to <strong>{result.email}</strong>.</p>
                <ActionForm intent="verify-code" action={action} className="form-stack" resetOn={result}>
                  <input type="hidden" name="challenge" value={result.challenge} />
                  <input type="hidden" name="email" value={result.email ?? ""} />
                  <label>Confirmation code
                    <input name="code" className="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
                  </label>
                  <Submit intent="verify-code">{changingEmail ? "Confirm email change" : "Confirm merge"}</Submit>
                </ActionForm>
                <div className="button-row entry-code-actions">
                  <ActionForm intent="send-code" action={action}>
                    <input type="hidden" name="email" value={result.email ?? ""} />
                    <input type="hidden" name="challenge" value={result.challenge} />
                    <Submit intent="send-code" appearance="button-quiet">Send a new code</Submit>
                  </ActionForm>
                  <a className="button button-quiet" href={action}>Use a different email</a>
                </div>
              </>
            ) : (
              <ActionForm key={mode} intent={usingPassword ? "merge-password" : "send-code"} action={action} className="form-stack" resetOn={result}>
                <label>{changingEmail ? "New email address" : "Other email address"}
                  <input type="email" name="email" autoComplete={usingPassword ? "username" : "email"} defaultValue={result?.email} maxLength={254} required />
                </label>
                {usingPassword && (
                  <label>Other account’s password
                    <input type="password" name="password" autoComplete="current-password" maxLength={maxPasswordLength} required />
                  </label>
                )}
                <Submit intent={usingPassword ? "merge-password" : "send-code"}>{usingPassword ? "Confirm merge" : "Send confirmation code"}</Submit>
              </ActionForm>
            )}
          </>
        )}
        {mode && (
          <div className="button-row account-nav">
            {mode === "merge-accounts" && canMergeWithCode && (
              <Link className="button button-quiet" to="/account?mode=merge-password">Use the other account’s password</Link>
            )}
            {usingPassword && canMergeWithCode && (
              <Link className="button button-quiet" to="/account?mode=merge-accounts">Use an email code</Link>
            )}
            <Link className="button button-quiet" to="/account">Back to account settings</Link>
          </div>
        )}
      </section>
    </div>
  );
}
