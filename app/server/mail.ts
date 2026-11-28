import { createHash } from "node:crypto";
import type { Env } from "../env.ts";

const maxJobsPerRun = 12;
const leaseSeconds = 120;
const requestTimeoutMs = 8_000;
// Leave a margin for dispatch and provider clock differences.
const retryWindowSeconds = 24 * 60 * 60 - 60;

type Mail = { to: string; subject: string; text: string };

type ClaimedMail = {
  event_key: string;
  kind: string;
  recipient: string;
  subject: string;
  body: string;
  attempts: number;
  first_attempt_at: number;
  sender: string | null;
};

class DeliveryError extends Error {
  readonly reason: string;
  readonly retry: boolean;
  readonly retryAfter: number;

  constructor(reason: string, retry: boolean, retryAfter = 0) {
    super(reason);
    this.reason = reason;
    this.retry = retry;
    this.retryAfter = retryAfter;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  const url = URL.parse(origin);
  return url !== null
    && url.origin === origin
    && (url.protocol === "http:" || url.protocol === "https:")
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function mailAvailable(env: Env, origin = env.APP_ORIGIN): boolean {
  return Boolean((env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim())
    || (env.LOCAL_MAIL === "log" && origin && isLoopbackOrigin(origin)));
}

export async function sendDirect(
  env: Env,
  mail: Mail,
  options: { origin?: string; key?: string; sender?: string; unsubscribeUrl?: string } = {},
): Promise<string> {
  if (env.LOCAL_MAIL === "log" && options.origin && isLoopbackOrigin(options.origin)) {
    console.info("[local mail]", mail);
    return "local";
  }
  const from = options.sender ?? env.MAIL_FROM;
  if (!env.RESEND_API_KEY || !from) {
    throw new DeliveryError("mail_not_configured", false);
  }

  const headers = new Headers({
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  });
  if (options.key) headers.set("Idempotency-Key", options.key);

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from, to: [mail.to], subject: mail.subject, text: mail.text,
        ...(options.unsubscribeUrl ? { headers: {
          "List-Unsubscribe": `<${options.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        } } : {}),
      }),
      // Workers supports manual redirects. Never forward the Resend key to another URL.
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new DeliveryError("provider_unreachable", true);
  }
  const body = await response.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
  if (response.ok) {
    if (typeof body?.id === "string" && body.id) return body.id;
    throw new DeliveryError("provider_response_missing_id", true);
  }

  const code = body?.name;
  const retry = response.status >= 500
    || response.status === 408
    || (response.status === 429 && code !== "monthly_quota_exceeded")
    || (response.status === 409 && code === "concurrent_idempotent_requests");
  const retryAfter = response.headers.get("Retry-After");
  const delay = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter)
    : retryAfter ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
    : 0;
  const quotaDelay = code === "daily_quota_exceeded"
    ? 86_400 - Math.floor(Date.now() / 1000) % 86_400
    : 0;
  throw new DeliveryError(
    `provider_http_${response.status}`,
    retry,
    Math.max(Number.isFinite(delay) ? delay : 0, quotaDelay),
  );
}

export async function processOutbox(env: Env): Promise<void> {
  const { DB } = env;
  // Cap periodic cleanup so a backlog does not starve delivery.
  const cutoff = new Date().toISOString();
  await DB.batch([
    DB.prepare("DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE expires_at <= unixepoch() LIMIT 100)"),
    DB.prepare("DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expiresAt <= ? LIMIT 100)").bind(cutoff),
    DB.prepare("DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expiresAt <= ? LIMIT 100)").bind(cutoff),
  ]);

  for (let index = 0; index < maxJobsPerRun; index++) {
    const lease = crypto.randomUUID();
    const job = await DB.prepare(`
      UPDATE email_outbox
      SET lease_token = ?, lease_until = unixepoch() + ?,
        first_attempt_at = COALESCE(first_attempt_at, unixepoch()), attempts = attempts + 1,
        sender = COALESCE(sender, ?)
      WHERE event_key = (
        SELECT event_key FROM email_outbox
        WHERE status = 'pending' AND next_attempt_at <= unixepoch()
          AND (lease_until IS NULL OR lease_until <= unixepoch())
        ORDER BY next_attempt_at, event_key LIMIT 1
      )
      RETURNING event_key, kind, recipient, subject, body, attempts, first_attempt_at, sender
    `).bind(lease, leaseSeconds, env.MAIL_FROM ?? null).first<ClaimedMail>();
    if (!job) return;

    const pending = "WHERE event_key = ? AND lease_token = ? AND status = 'pending'";
    const current = await DB.prepare(`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM groups WHERE id = email_outbox.group_id)
        AND (kind NOT IN ('draw', 'wishlist-reminder') OR draw_id = (
          SELECT active_draw_id FROM seasons
          WHERE group_id = email_outbox.group_id ORDER BY year DESC LIMIT 1
        ))
        THEN 1 ELSE 0 END AS current,
        unixepoch() AS now
      FROM email_outbox ${pending} AND lease_until > unixepoch()
    `).bind(job.event_key, lease).first<{ current: number; now: number }>();
    if (!current) continue;

    // Recheck reminders at delivery, including retries: the recipient may have
    // added a wish, opted out, changed accounts, or finished their exchange.
    const reminder = job.kind === "wishlist-reminder" ? await DB.prepare(`
      SELECT e.unsubscribe_url AS unsubscribeUrl
      FROM email_outbox e
      JOIN memberships m ON m.id = e.reminder_member_id AND m.group_id = e.group_id
      JOIN "user" u ON u.id = m.user_id AND u.email = e.recipient AND m.email = u.email
      JOIN seasons s ON s.group_id = m.group_id AND s.active_draw_id = e.draw_id
      JOIN draws d ON d.id = s.active_draw_id
      JOIN assignments a ON a.draw_id = d.id AND a.recipient_id = m.id
      WHERE e.event_key = ? AND e.lease_token = ? AND e.status = 'pending' AND e.lease_until > unixepoch()
        AND s.completed = 0 AND u.emailVerified = 1 AND u.wishlist_reminders_enabled = 1
        AND (d.release_at IS NULL OR d.release_at <= unixepoch())
        AND s.id = (SELECT id FROM seasons WHERE group_id = s.group_id ORDER BY year DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM gift_items WHERE owner_id = m.user_id AND (group_id IS NULL OR group_id = m.group_id))
    `).bind(job.event_key, lease).first<{ unsubscribeUrl: string }>() : null;

    if (!current.current || (job.kind === "wishlist-reminder" && !reminder)) {
      await DB.prepare(`
        UPDATE email_outbox SET status = 'cancelled', lease_until = NULL, lease_token = NULL ${pending}
      `).bind(job.event_key, lease).run();
      continue;
    }

    const deadline = job.first_attempt_at + retryWindowSeconds;
    let providerId: string | null = null;
    let failure: DeliveryError | undefined;
    if (current.now >= deadline) {
      failure = new DeliveryError("retry_window_expired", false);
    } else {
      const key = "outbox/" + createHash("sha256").update(job.event_key).digest("hex");
      try {
        providerId = await sendDirect(env, {
          to: job.recipient,
          subject: job.subject,
          text: job.body,
        }, { key, origin: env.APP_ORIGIN, sender: job.sender ?? undefined, unsubscribeUrl: reminder?.unsubscribeUrl });
      } catch (error) {
        failure = error instanceof DeliveryError ? error : new DeliveryError("delivery_error", true);
      }
    }

    if (providerId !== null) {
      await DB.prepare(`
        UPDATE email_outbox SET status = 'sent', sent_at = unixepoch(), provider_id = ?,
          last_error = NULL, lease_until = NULL, lease_token = NULL ${pending}
      `).bind(providerId, job.event_key, lease).run();
    } else if (failure) {
      const backoff = Math.min(60 * 2 ** Math.min(job.attempts - 1, 6), 3_600);
      const next = Math.floor(Date.now() / 1000) + Math.max(backoff, failure.retryAfter);
      const status = failure.retry && next < deadline ? "pending" : "failed";
      await DB.prepare(`
        UPDATE email_outbox SET status = ?, next_attempt_at = ?, last_error = ?,
          lease_until = NULL, lease_token = NULL ${pending}
      `).bind(status, next, failure.reason, job.event_key, lease).run();
    }
  }
}
