import { createHmac, timingSafeEqual } from "node:crypto";
import type { Env } from "../env.ts";
import { exchangePath } from "../types.ts";
import { mailAvailable } from "./mail.ts";

const firstReminderDelay = 24 * 60 * 60;
const reminderInterval = 3 * 24 * 60 * 60;
const maxRemindersPerRun = 50;

type Recipient = {
  memberId: string;
  userId: string;
  email: string;
  groupId: string;
  groupName: string;
  drawId: string;
  sequence: number;
};

// This query also guards the INSERT, because a wish, opt-out, or redraw can
// arrive between discovering a recipient and persisting their reminder.
const eligibleRecipients = `
  SELECT m.id AS memberId, u.id AS userId, u.email, g.id AS groupId,
    g.name AS groupName, d.id AS drawId,
    (SELECT count(*) FROM email_outbox e
      WHERE e.kind = 'wishlist-reminder' AND e.reminder_member_id = m.id) AS sequence
  FROM seasons s
  JOIN draws d ON d.id = s.active_draw_id
  JOIN assignments a ON a.draw_id = d.id
  JOIN memberships m ON m.id = a.recipient_id AND m.group_id = s.group_id
  JOIN groups g ON g.id = m.group_id
  JOIN "user" u ON u.id = m.user_id AND u.email = m.email
  WHERE s.completed = 0 AND u.emailVerified = 1 AND u.wishlist_reminders_enabled = 1
    AND s.id = (SELECT id FROM seasons WHERE group_id = s.group_id ORDER BY year DESC LIMIT 1)
    AND max(d.created_at, coalesce(d.release_at, d.created_at)) + ${firstReminderDelay} <= unixepoch()
    AND NOT EXISTS (SELECT 1 FROM gift_items WHERE owner_id = m.id)
    AND NOT EXISTS (
      SELECT 1 FROM email_outbox e
      WHERE e.kind = 'wishlist-reminder' AND e.reminder_member_id = m.id
        AND (e.status = 'pending' OR max(e.created_at, coalesce(e.sent_at, 0), coalesce(e.first_attempt_at, 0))
          > unixepoch() - ${reminderInterval})
    )
`;

function unsubscribeToken(env: Env, userId: string, email: string) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(JSON.stringify(["wishlist-reminders", userId, email])).digest("hex");
}

function unsubscribeUrl(env: Env, userId: string, email: string) {
  const url = new URL("/wishlist-reminders/unsubscribe", env.APP_ORIGIN);
  url.searchParams.set("user", userId);
  url.searchParams.set("token", unsubscribeToken(env, userId, email));
  return url.href;
}

export async function queueWishlistReminders(env: Env): Promise<number> {
  if (!env.APP_ORIGIN || !mailAvailable(env)) return 0;
  const { results } = await env.DB.prepare(`
    ${eligibleRecipients} ORDER BY d.created_at, m.id LIMIT ?
  `).bind(maxRemindersPerRun).all<Recipient>();

  let queued = 0;
  for (const recipient of results) {
    const unsubscribe = unsubscribeUrl(env, recipient.userId, recipient.email);
    const wishlist = new URL(exchangePath(recipient.groupId), env.APP_ORIGIN);
    wishlist.hash = "wish-list";
    const body = `Your Secret Santa in ${recipient.groupName} could use a few ideas. Add at least one item to your wish list to help them choose a gift.\n\nAdd a wish: ${wishlist}\n\nWe’ll remind you every three days while your wish list is empty and this exchange is active. Adding a wish stops these reminders.\n\nStop wishlist reminders for all my exchanges: ${unsubscribe}`;
    const result = await env.DB.prepare(`
      INSERT INTO email_outbox (
        event_key, kind, group_id, draw_id, recipient, subject, body, reminder_member_id, unsubscribe_url
      )
      SELECT ?, 'wishlist-reminder', r.groupId, r.drawId, r.email, ?, ?, r.memberId, ?
      FROM (${eligibleRecipients}) r
      WHERE r.memberId = ? AND r.drawId = ? AND r.userId = ? AND r.email = ?
      ON CONFLICT(event_key) DO NOTHING
    `).bind(
      `wishlist-reminder:${recipient.drawId}:${recipient.memberId}:${recipient.sequence}`,
      "Add a wish for your Secret Santa", body, unsubscribe,
      recipient.memberId, recipient.drawId, recipient.userId, recipient.email,
    ).run();
    queued += result.meta.changes;
  }
  return queued;
}

export async function getReminderPreference(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT wishlist_reminders_enabled AS enabled FROM "user" WHERE id = ?')
    .bind(userId).first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function setReminderPreference(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await db.batch([
    db.prepare('UPDATE "user" SET wishlist_reminders_enabled = ? WHERE id = ?').bind(Number(enabled), userId),
    db.prepare(`
      UPDATE email_outbox SET status = 'cancelled', lease_token = NULL, lease_until = NULL
      WHERE kind = 'wishlist-reminder' AND status = 'pending' AND ? = 0
        AND reminder_member_id IN (SELECT id FROM memberships WHERE user_id = ?)
    `).bind(Number(enabled), userId),
  ]);
}

export async function validateUnsubscribeLink(env: Env, url: URL) {
  const userId = url.searchParams.get("user") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!userId || userId.length > 128 || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = await env.DB.prepare('SELECT email, wishlist_reminders_enabled AS enabled FROM "user" WHERE id = ?')
    .bind(userId).first<{ email: string; enabled: number }>();
  if (!user || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(unsubscribeToken(env, userId, user.email), "hex"))) {
    return null;
  }
  return { userId, enabled: user.enabled === 1 };
}

export async function unsubscribeFromReminders(env: Env, url: URL): Promise<boolean> {
  const state = await validateUnsubscribeLink(env, url);
  if (!state) return false;
  await setReminderPreference(env.DB, state.userId, false);
  return true;
}
