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

export async function sendDirect(
  env: Env,
  mail: Mail,
  options: { origin?: string; key?: string; sender?: string } = {},
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
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      redirect: "error",
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
      RETURNING event_key, recipient, subject, body, attempts, first_attempt_at, sender
    `).bind(lease, leaseSeconds, env.MAIL_FROM ?? null).first<ClaimedMail>();
    if (!job) return;

    const pending = "WHERE event_key = ? AND lease_token = ? AND status = 'pending'";
    const current = await DB.prepare(`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM groups WHERE id = email_outbox.group_id)
        AND (kind <> 'draw' OR draw_id = (
          SELECT active_draw_id FROM seasons
          WHERE group_id = email_outbox.group_id ORDER BY year DESC LIMIT 1
        ))
        THEN 1 ELSE 0 END AS current,
        unixepoch() AS now
      FROM email_outbox ${pending} AND lease_until > unixepoch()
    `).bind(job.event_key, lease).first<{ current: number; now: number }>();
    if (!current) continue;

    if (!current.current) {
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
        }, { key, origin: env.APP_ORIGIN, sender: job.sender ?? undefined });
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
