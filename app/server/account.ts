import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Env } from "../env.ts";
import { maxPasswordLength } from "../password.ts";
import { allowAuthAttempt, digest, emailSignInEnabled, normalizeEmail } from "./auth.ts";
import { mailAvailable, sendDirect } from "./mail.ts";

export type AccountSession = {
  user: { id: string; email: string; emailVerified: boolean };
  session: { id: string };
};

export type EmailOperation = "change-email" | "merge-accounts";

export class AccountError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 409 | 429 | 503 = 400) {
    super(message);
  }
}

const codeSeconds = 5 * 60;
const staleAccount = "Your sign-in or account details changed. Reload this page and try again.";
const invalidCode = "That code is incorrect or expired. Try again or request a new code.";
const tooManyAttempts = "Too many attempts. Try again in a few minutes.";

const activeSession = `EXISTS (
  SELECT 1 FROM session s JOIN "user" u ON u.id = s.userId
  WHERE s.id = ? AND u.id = ? AND u.email = ? AND u.emailVerified = ? AND s.expiresAt > ?
)`;

function sessionBindings({ user, session }: AccountSession, now = new Date().toISOString()) {
  return [session.id, user.id, user.email, Number(user.emailVerified), now] as const;
}

function targetEmail(actor: AccountSession, input: unknown) {
  const email = normalizeEmail(input);
  if (!email) throw new AccountError("Enter a valid email address.");
  if (email === actor.user.email.toLowerCase()) throw new AccountError("Enter a different email address.");
  return email;
}

function accountCodeHash(env: Env, challenge: string, code: string) {
  return digest(env.BETTER_AUTH_SECRET, "account-email:" + challenge, code);
}

export async function sendAccountCode(
  request: Request, env: Env, actor: AccountSession, purpose: EmailOperation, input: unknown,
): Promise<string> {
  const origin = new URL(request.url).origin;
  const changingEmail = purpose === "change-email";
  if (!(changingEmail ? mailAvailable(env, origin) : emailSignInEnabled(env, origin))) {
    throw new AccountError("Email verification is unavailable right now.", 503);
  }
  const email = targetEmail(actor, input);
  if (!await allowAuthAttempt(request, env, "account-code", email, 20, 4, 45)) {
    throw new AccountError(tooManyAttempts, 429);
  }

  const id = crypto.randomUUID();
  const code = randomInt(1_000_000).toString().padStart(6, "0");
  const saved = await env.DB.prepare(`
    INSERT OR REPLACE INTO account_email_codes (
      id, session_id, purpose, current_email, target_email, other_user_id, code_hash, attempts_left, expires_at
    )
    SELECT ?, ?, ?, ?, ?, (SELECT id FROM "user" WHERE email = ? AND emailVerified = 1), ?, 3, unixepoch() + ?
    WHERE ${activeSession}
  `).bind(id, actor.session.id, purpose, actor.user.email, email, changingEmail ? null : email,
    accountCodeHash(env, id, code), codeSeconds, ...sessionBindings(actor)).run();
  if (!saved.meta.changes) throw new AccountError(staleAccount, 409);

  const action = changingEmail ? "change your Secret Santa email address" : "merge your Secret Santa accounts";
  try {
    await sendDirect(env, {
      to: email,
      subject: changingEmail ? "Confirm your Secret Santa email change" : "Confirm your Secret Santa account merge",
      text: `Your confirmation code is ${code}. It expires in 5 minutes.\n\nEnter it in Account settings to ${action}. If you didn’t request this, you can ignore this email.`,
    }, { origin, key: "account-code/" + id });
  } catch {
    await env.DB.prepare("DELETE FROM account_email_codes WHERE id = ?").bind(id).run();
    throw new AccountError("We couldn’t send a code right now. Try again in a moment.", 503);
  }
  return id;
}

export async function confirmAccountCode(
  env: Env, actor: AccountSession, purpose: EmailOperation, challenge: unknown, code: unknown,
): Promise<void> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new AccountError("Enter the six-digit code.");
  if (typeof challenge !== "string" || !/^[a-f0-9-]{36}$/.test(challenge)) throw new AccountError(invalidCode);

  // Mark a correct code as used in the same write that counts an incorrect attempt.
  const result = await env.DB.prepare(`
    UPDATE account_email_codes
    SET attempts_left = CASE WHEN code_hash = ? THEN -1 ELSE attempts_left - 1 END
    WHERE id = ? AND session_id = ? AND current_email = ? AND purpose = ?
      AND attempts_left > 0 AND expires_at > unixepoch() AND ${activeSession}
    RETURNING target_email, other_user_id, attempts_left
  `).bind(accountCodeHash(env, challenge, code), challenge, actor.session.id, actor.user.email,
    purpose, ...sessionBindings(actor)).first<{ target_email: string; other_user_id: string | null; attempts_left: number }>();
  if (result?.attempts_left !== -1) throw new AccountError(invalidCode);

  const email = result.target_email;
  if (purpose === "change-email") {
    await changeEmail(env.DB, actor, email);
  } else {
    if (!result.other_user_id) {
      throw new AccountError("Enter the other account’s password or check the email address.", 409);
    }
    await mergeAccounts(env.DB, actor, { id: result.other_user_id, email });
  }
}

export async function mergeWithPassword(
  request: Request, env: Env, actor: AccountSession, input: unknown, password: unknown,
): Promise<void> {
  const email = targetEmail(actor, input);
  if (typeof password !== "string" || !password || password.length > maxPasswordLength) {
    throw new AccountError("Enter the other account’s password.");
  }
  if (!await allowAuthAttempt(request, env, "password", email, 30, 10)) {
    throw new AccountError(tooManyAttempts, 429);
  }

  const account = await env.DB.prepare(`
    SELECT u.id, a.password FROM "user" u JOIN account a ON a.userId = u.id AND a.accountId = u.id
    WHERE u.email = ? AND a.providerId = 'credential' AND a.password IS NOT NULL
  `).bind(email).first<{ id: string; password: string }>();
  if (!account?.password) await hashPassword(password);
  if (!account?.password || !await verifyPassword({ hash: account.password, password })) {
    throw new AccountError("The other account’s email address or password is incorrect.", 401);
  }
  await mergeAccounts(env.DB, actor, { id: account.id, email, passwordHash: account.password });
}

function redirectPendingMail(
  db: D1Database, userId: string, email: string, verified: boolean, guard: string, bindings: readonly (string | number)[],
) {
  // A provider retry must keep its original payload. Cancel started deliveries and retarget unsent ones.
  return db.prepare(`
    UPDATE email_outbox SET
      recipient = CASE WHEN first_attempt_at IS NULL AND ? THEN ? ELSE recipient END,
      status = CASE WHEN first_attempt_at IS NULL AND ? THEN 'pending' ELSE 'cancelled' END,
      lease_token = NULL, lease_until = NULL
    WHERE event_key IN (
      SELECT e.event_key FROM memberships m JOIN email_outbox e ON e.group_id = m.group_id
      WHERE m.user_id = ? AND e.status = 'pending' AND e.recipient <> ? AND (
        e.event_key = 'welcome:' || m.id OR e.event_key = 'draw:' || e.draw_id || ':' || m.id
      )
    ) AND ${guard}
  `).bind(Number(verified), email, Number(verified), userId, email, ...bindings);
}

async function changeEmail(db: D1Database, actor: AccountSession, email: string) {
  const guard = `${activeSession} AND NOT EXISTS (SELECT 1 FROM "user" WHERE email = ?)`;
  const now = new Date().toISOString();
  const bindings = [...sessionBindings(actor, now), email];
  const id = actor.user.id;
  const [, , , changed] = await db.batch([
    redirectPendingMail(db, id, email, true, guard, bindings),
    db.prepare(`UPDATE memberships SET email = ? WHERE user_id = ? AND ${guard}`).bind(email, id, ...bindings),
    db.prepare(`DELETE FROM session WHERE userId = ? AND id <> ? AND ${guard}`).bind(id, actor.session.id, ...bindings),
    db.prepare(`
      UPDATE "user" SET email = ?, emailVerified = 1, updatedAt = ? WHERE id = ? AND ${guard}
    `).bind(email, now, id, ...bindings),
  ]);
  if (changed.meta.changes) return;
  if (await db.prepare('SELECT 1 FROM "user" WHERE email = ? AND id <> ?').bind(email, id).first()) {
    throw new AccountError("That email already has an account. Use Merge accounts to bring its exchanges here.", 409);
  }
  throw new AccountError(staleAccount, 409);
}

async function mergeAccounts(db: D1Database, actor: AccountSession, other: { id: string; email: string; passwordHash?: string }) {
  const overlap = `SELECT 1 FROM memberships a JOIN memberships b ON b.group_id = a.group_id
    WHERE a.user_id = ? AND b.user_id = ?`;
  const ids = [actor.user.id, other.id];
  const proof = other.passwordHash === undefined ? "u.emailVerified = 1" : `EXISTS (
    SELECT 1 FROM account WHERE userId = u.id AND accountId = u.id AND providerId = 'credential' AND password = ?
  )`;
  const guard = `${activeSession} AND EXISTS (
    SELECT 1 FROM "user" u WHERE u.id = ? AND u.email = ? AND ${proof}
  ) AND NOT EXISTS (${overlap})`;
  const bindings = [...sessionBindings(actor), other.id, other.email,
    ...(other.passwordHash === undefined ? [] : [other.passwordHash]), ...ids];
  // Keep the membership IDs that drawings, addresses, and wish lists already reference.
  const [, , merged] = await db.batch([
    redirectPendingMail(db, other.id, actor.user.email, actor.user.emailVerified, guard, bindings),
    db.prepare(`UPDATE memberships SET user_id = ?, email = ? WHERE user_id = ? AND ${guard}`)
      .bind(actor.user.id, actor.user.email, other.id, ...bindings),
    db.prepare(`DELETE FROM "user" WHERE id = ? AND ${guard}`).bind(other.id, ...bindings),
  ]);
  if (merged.meta.changes) return;
  if (await db.prepare(overlap).bind(...ids).first()) {
    throw new AccountError("Both accounts belong to the same exchange. A merge would create a duplicate participant.", 409);
  }
  throw new AccountError(staleAccount, 409);
}
