import { findDraw, type Assignment, type Exclusion } from "./matching.ts";
import { MembershipChanged } from "./actor.ts";

type VerifiedUser = { id: string; email: string };
type Role = "organizer" | "member";
type Invite = { name: string; description: string; code: string };
type Membership = Invite & { groupId: string; membershipId: string; role: Role };
type SeasonHead = { id: string; year: number; completed: number; revision: number; drawId: string | null };
type MemberRow = { id: string; name: string; email: string; eligible: number };

const codeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const seasonChanged = "The exchange changed. Refresh the page and try again.";

export class ExchangeError extends Error {}

function validYear(value: unknown) {
  const year = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new ExchangeError("Enter a four-digit exchange year.");
  }
  return year;
}

function requiredName(value: string, label: string) {
  const name = value.trim();
  if (!name || name.length > 80) throw new ExchangeError(`Enter ${label} of up to 80 characters.`);
  return name;
}

function shareCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => codeAlphabet[byte % 32]).join("");
}

function membership(db: D1Database, userId: string) {
  return db.prepare(`
    SELECT m.id AS membershipId, g.id AS groupId, g.name, g.description, g.code, m.role
    FROM memberships m JOIN groups g ON g.id = m.group_id
    JOIN "user" u ON u.id = m.user_id AND u.emailVerified = 1
    WHERE m.user_id = ?
  `).bind(userId).first<Membership>();
}

export function getInvite(db: D1Database, rawCode: string) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-7]{16}$/.test(code)) return Promise.resolve(null);
  return db.prepare("SELECT name, description, code FROM groups WHERE code = ?").bind(code).first<Invite>();
}

function welcome(db: D1Database, membershipId: string, origin?: string) {
  return db.prepare(`
    INSERT INTO email_outbox(event_key, kind, group_id, recipient, subject, body)
    SELECT 'welcome:' || m.id, 'welcome', m.group_id, m.email, 'Welcome to your gift exchange',
      'You joined ' || g.name || '. Happy gifting!' || ?
    FROM memberships m JOIN groups g ON g.id = m.group_id WHERE m.id = ?
  `).bind(origin ? `\n\nOpen your exchange: ${new URL("/exchange", origin)}` : "", membershipId);
}

export async function createGroup(
  db: D1Database,
  user: VerifiedUser,
  input: { name: string; description: string; year: number | string; displayName: string },
  origin?: string,
) {
  const name = requiredName(input.name, "a group name");
  const displayName = requiredName(input.displayName, "a display name");
  const description = input.description.trim();
  if (description.length > 500) throw new ExchangeError("Use 500 characters or fewer for the description.");
  const year = validYear(input.year);
  const groupId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const seasonId = crypto.randomUUID();

  const [created] = await db.batch([
    db.prepare(`
      INSERT INTO groups(id, name, description, code)
      SELECT ?, ?, ?, ? FROM "user" u
      WHERE u.id = ? AND u.emailVerified = 1
        AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = u.id)
    `).bind(groupId, name, description, shareCode(), user.id),
    db.prepare(`
      INSERT INTO memberships(id, group_id, user_id, email, name, role)
      SELECT ?, g.id, u.id, lower(u.email), ?, 'organizer'
      FROM groups g JOIN "user" u ON u.id = ? WHERE g.id = ?
    `).bind(memberId, displayName, user.id, groupId),
    db.prepare(`
      INSERT INTO seasons(id, group_id, year) SELECT ?, id, ? FROM groups WHERE id = ?
    `).bind(seasonId, year, groupId),
    db.prepare(`
      INSERT INTO season_participants(group_id, season_id, membership_id)
      SELECT group_id, ?, id FROM memberships WHERE id = ?
    `).bind(seasonId, memberId),
    welcome(db, memberId, origin),
  ]);
  if (!created.meta.changes) throw new ExchangeError("Verify your email and make sure you do not already belong to a group.");
}

export async function joinGroup(
  db: D1Database, user: VerifiedUser, rawCode: string, rawName: string, origin?: string,
) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z2-7]{16}$/.test(code)) throw new ExchangeError("Enter a valid invitation code.");
  const name = requiredName(rawName, "a display name");
  const memberId = crypto.randomUUID();

  const [joined] = await db.batch([
    db.prepare(`
      INSERT INTO memberships(id, group_id, user_id, email, name, role)
      SELECT ?, g.id, u.id, lower(u.email), ?, 'member'
      FROM groups g JOIN "user" u ON u.id = ? AND u.emailVerified = 1
      WHERE g.code = ? AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = u.id)
    `).bind(memberId, name, user.id, code),
    db.prepare(`
      INSERT INTO season_participants(group_id, season_id, membership_id)
      SELECT s.group_id, s.id, m.id FROM memberships m
      JOIN seasons s ON s.group_id = m.group_id AND s.completed = 0 WHERE m.id = ?
    `).bind(memberId),
    db.prepare(`
      UPDATE seasons SET revision = revision + 1
      WHERE id = (SELECT season_id FROM season_participants WHERE membership_id = ?)
    `).bind(memberId),
    welcome(db, memberId, origin),
  ]);
  if (joined.meta.changes) return;

  const current = await membership(db, user.id);
  if (current?.code === code) return;
  if (current) throw new ExchangeError("You already belong to a group.");
  throw new ExchangeError("This invitation is unavailable. Check the code and verify your email.");
}

export async function getExchange(db: D1Database, userId: string) {
  const row = await db.prepare(`
    SELECT g.id AS groupId, g.name, g.description, g.code,
      self.id AS selfId, self.name AS selfName, self.role,
      s.id AS seasonId, s.year, s.completed, s.revision, d.id AS drawId, d.revision AS drawRevision,
      recipient.id AS recipientId, recipient.name AS recipientName,
      CASE WHEN self.role = 'organizer' THEN (
        SELECT json_group_array(json_object(
          'id', m.id, 'name', m.name, 'email', m.email, 'eligible', coalesce(p.eligible, 0)
        ))
        FROM memberships m
        LEFT JOIN season_participants p ON p.membership_id = m.id AND p.season_id = s.id
        WHERE m.group_id = g.id
      ) ELSE '[]' END AS members,
      CASE WHEN self.role = 'organizer' THEN (
        SELECT json_group_array(json_object('firstId', first_id, 'secondId', second_id))
        FROM pair_exclusions WHERE group_id = g.id
      ) ELSE '[]' END AS exclusions,
      CASE WHEN self.role = 'organizer' THEN (
        SELECT count(*) FROM season_participants p
        WHERE p.season_id = s.id AND p.eligible = 1 AND NOT EXISTS (
          SELECT 1 FROM assignments a WHERE a.draw_id = d.id AND a.giver_id = p.membership_id
        )
      ) ELSE 0 END AS waitingCount,
      CASE WHEN self.role = 'organizer' THEN (
        SELECT count(*) FROM email_outbox e WHERE e.group_id = g.id AND e.status = 'failed'
          AND (e.draw_id IS NULL OR e.draw_id = d.id)
      ) ELSE 0 END AS mailFailures
    FROM memberships self
    JOIN "user" u ON u.id = self.user_id AND u.emailVerified = 1
    JOIN groups g ON g.id = self.group_id
    LEFT JOIN seasons s ON s.id = (SELECT id FROM seasons WHERE group_id = g.id ORDER BY year DESC LIMIT 1)
    LEFT JOIN draws d ON d.id = s.active_draw_id
    LEFT JOIN assignments a ON a.draw_id = d.id AND a.giver_id = self.id
    LEFT JOIN memberships recipient ON recipient.id = a.recipient_id
    WHERE self.user_id = ?
  `).bind(userId).first<{
    groupId: string; name: string; description: string; code: string;
    selfId: string; selfName: string; role: Role;
    seasonId: string | null; year: number; completed: number; revision: number; drawId: string | null; drawRevision: number | null;
    recipientId: string | null; recipientName: string;
    members: string; exclusions: string; waitingCount: number; mailFailures: number;
  }>();
  if (!row) return null;
  return {
    group: { id: row.groupId, name: row.name, description: row.description, code: row.code },
    self: { id: row.selfId, name: row.selfName, role: row.role },
    season: row.seasonId ? {
      id: row.seasonId, year: row.year, completed: Boolean(row.completed),
      revision: row.revision, drawId: row.drawId, drawRevision: row.drawRevision,
    } : null,
    members: (JSON.parse(row.members) as MemberRow[])
      .map((member) => ({ ...member, eligible: Boolean(member.eligible) }))
      .sort((first, second) => first.name.localeCompare(second.name)),
    exclusions: JSON.parse(row.exclusions) as Exclusion[],
    recipient: row.recipientId ? { id: row.recipientId, name: row.recipientName } : null,
    waitingCount: row.waitingCount,
    mailFailures: row.mailFailures,
  };
}

function field(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function seasonReference(form: FormData) {
  const id = field(form, "seasonId");
  const rawRevision = field(form, "revision");
  const revision = Number(rawRevision);
  if (!id || !/^\d+$/.test(rawRevision) || !Number.isSafeInteger(revision)) throw new ExchangeError(seasonChanged);
  return { id, revision, drawId: field(form, "drawId") || null };
}

function requireConfirmation(form: FormData, message: string) {
  if (field(form, "confirm") !== "yes") throw new ExchangeError(message);
}

async function startSeason(db: D1Database, groupId: string, year: number) {
  const id = crypto.randomUUID();
  const [created] = await db.batch([
    db.prepare(`
      INSERT INTO seasons(id, group_id, year)
      SELECT ?, g.id, ? FROM groups g WHERE g.id = ?
        AND NOT EXISTS (SELECT 1 FROM seasons WHERE group_id = g.id AND completed = 0)
        AND NOT EXISTS (SELECT 1 FROM seasons WHERE group_id = g.id AND year >= ?)
    `).bind(id, year, groupId, year),
    db.prepare(`
      INSERT INTO season_participants(group_id, season_id, membership_id, eligible)
      SELECT s.group_id, s.id, m.id, previous.id IS NULL OR EXISTS (
        SELECT 1 FROM assignments a WHERE a.draw_id = previous.active_draw_id AND a.giver_id = m.id
      )
      FROM seasons s JOIN memberships m ON m.group_id = s.group_id
      LEFT JOIN seasons previous ON previous.id = (
        SELECT id FROM seasons WHERE group_id = s.group_id AND completed = 1 ORDER BY year DESC LIMIT 1
      )
      WHERE s.id = ?
    `).bind(id),
    db.prepare(`
      UPDATE email_outbox SET status = 'cancelled'
      WHERE group_id = ? AND kind = 'draw' AND status = 'pending' AND EXISTS (SELECT 1 FROM seasons WHERE id = ?)
    `).bind(groupId, id),
  ]);
  if (!created.meta.changes) {
    throw new ExchangeError("Finish or discard the open exchange first, then choose a year after your last completed exchange.");
  }
  return `The ${year} exchange is open.`;
}

async function setRoster(db: D1Database, groupId: string, form: FormData) {
  const { id, revision } = seasonReference(form);
  const ids = JSON.stringify(form.getAll("memberId").map((value) => typeof value === "string" ? value : ""));
  const eligible = "membership_id IN (SELECT value FROM json_each(?))";
  const editable = `SELECT id FROM seasons s
    WHERE s.id = ? AND s.group_id = ? AND s.completed = 0 AND s.revision = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) chosen
        WHERE NOT EXISTS (
          SELECT 1 FROM season_participants WHERE season_id = s.id AND membership_id = chosen.value
        )
      )`;

  const [checked] = await db.batch([
    db.prepare(editable).bind(id, groupId, revision, ids),
    db.prepare(`
      UPDATE season_participants SET eligible = ${eligible}
      WHERE season_id IN (${editable}) AND eligible <> (${eligible})
    `).bind(ids, id, groupId, revision, ids, ids),
    db.prepare("UPDATE seasons SET revision = revision + 1 WHERE id = ? AND changes() > 0").bind(id),
  ]);
  if (!checked.results.length) throw new ExchangeError("The roster changed or includes an invalid member. Refresh the page and try again.");
  return "Roster saved.";
}

async function changeExclusion(db: D1Database, groupId: string, form: FormData, add: boolean) {
  const [firstId, secondId] = [field(form, "firstId"), field(form, "secondId")].sort();
  if (!firstId || firstId === secondId) throw new ExchangeError("Choose two different members.");

  if (add) {
    const result = await db.prepare(`
      INSERT INTO pair_exclusions(group_id, first_id, second_id)
      SELECT first.group_id, first.id, second.id FROM memberships first
      JOIN memberships second ON first.group_id = second.group_id
      WHERE first.id = ? AND second.id = ? AND first.group_id = ?
      ON CONFLICT(group_id, first_id, second_id) DO NOTHING
    `).bind(firstId, secondId, groupId).run();
    if (!result.meta.changes) {
      const existing = await db.prepare("SELECT 1 FROM pair_exclusions WHERE group_id = ? AND first_id = ? AND second_id = ?")
        .bind(groupId, firstId, secondId).first();
      if (!existing) throw new ExchangeError("Choose two members of your group.");
    }
    return "Exclusion saved.";
  }

  await db.prepare("DELETE FROM pair_exclusions WHERE group_id = ? AND first_id = ? AND second_id = ?")
    .bind(groupId, firstId, secondId).run();
  return "Exclusion removed.";
}

async function publishDraw(db: D1Database, group: Membership, form: FormData, origin: string) {
  const reference = seasonReference(form);
  const requestKey = field(form, "requestId");
  if (!requestKey || requestKey.length > 100) throw new ExchangeError("Refresh the page before running the draw.");
  const { groupId } = group;
  const alreadyPublished = db.prepare("SELECT id FROM draws WHERE group_id = ? AND season_id = ? AND request_key = ?")
    .bind(groupId, reference.id, requestKey);

  const [seasons, participants, exclusions, history, existing] = await db.batch([
    db.prepare("SELECT id, year, completed, revision, active_draw_id AS drawId FROM seasons WHERE group_id = ? AND id = ?")
      .bind(groupId, reference.id),
    db.prepare("SELECT membership_id AS id FROM season_participants WHERE group_id = ? AND season_id = ? AND eligible = 1")
      .bind(groupId, reference.id),
    db.prepare("SELECT first_id AS firstId, second_id AS secondId FROM pair_exclusions WHERE group_id = ?").bind(groupId),
    db.prepare(`
      SELECT giver_id AS giverId, recipient_id AS recipientId FROM assignments
      WHERE draw_id = (
        SELECT active_draw_id FROM seasons WHERE group_id = ? AND completed = 1 ORDER BY year DESC LIMIT 1
      )
    `).bind(groupId),
    alreadyPublished,
  ]);
  if (existing.results.length) return "This draw was already published.";

  const current = seasons.results[0] as SeasonHead | undefined;
  if (!current || current.completed || current.revision !== reference.revision || current.drawId !== reference.drawId) {
    throw new ExchangeError(seasonChanged);
  }
  if (current.drawId) requireConfirmation(form, "Confirm the redraw. Everyone may get a different recipient.");

  const roster = (participants.results as { id: string }[]).map(({ id }) => id);
  const assignments = findDraw(roster, exclusions.results as Exclusion[], history.results as Assignment[]);
  if (!assignments) throw new ExchangeError("There is no complete draw for this roster and its exclusions and repeat rules.");

  const id = crypto.randomUUID();
  const [published] = await db.batch([
    db.prepare(`
      INSERT INTO draws(id, group_id, season_id, revision, request_key)
      SELECT ?, group_id, id, revision, ? FROM seasons
      WHERE id = ? AND group_id = ? AND completed = 0 AND revision = ? AND active_draw_id IS ?
      ON CONFLICT(season_id, request_key) DO NOTHING
    `).bind(id, requestKey, reference.id, groupId, reference.revision, reference.drawId),
    db.prepare(`
      INSERT INTO assignments(draw_id, season_id, giver_id, recipient_id)
      SELECT d.id, d.season_id, json_extract(edge.value, '$.giverId'), json_extract(edge.value, '$.recipientId')
      FROM draws d CROSS JOIN json_each(?) edge WHERE d.id = ?
    `).bind(JSON.stringify(assignments), id),
    db.prepare(`
      UPDATE seasons SET active_draw_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM draws WHERE id = ?)
    `).bind(id, reference.id, id),
    db.prepare(`
      UPDATE email_outbox SET status = 'cancelled'
      WHERE group_id = ? AND kind = 'draw' AND status = 'pending' AND EXISTS (SELECT 1 FROM draws WHERE id = ?)
    `).bind(groupId, id),
    db.prepare(`
      INSERT INTO email_outbox(event_key, kind, group_id, draw_id, recipient, subject, body)
      SELECT 'draw:' || d.id || ':' || m.id, 'draw', d.group_id, d.id, m.email, ?, ?
      FROM draws d JOIN assignments a ON a.draw_id = d.id
      JOIN memberships m ON m.id = a.giver_id WHERE d.id = ?
    `).bind("Your Secret Santa draw is ready", `Sign in to see your recipient for ${group.name}.\n\n${new URL("/", origin)}`, id),
  ]);
  if (published.meta.changes) return "Draw published. Notifications are queued.";
  if (await alreadyPublished.first()) return "This draw was already published.";
  throw new ExchangeError(seasonChanged);
}

async function finishSeason(db: D1Database, groupId: string, form: FormData, complete: boolean) {
  requireConfirmation(form, complete ? "Confirm completion of this exchange." : "Confirm that you want to discard this exchange.");
  const { id, revision, drawId } = seasonReference(form);
  const result = complete
    ? await db.prepare(`
      UPDATE seasons SET completed = 1
      WHERE id = ? AND group_id = ? AND completed = 0 AND revision = ? AND active_draw_id = ?
    `).bind(id, groupId, revision, drawId).run()
    : await db.prepare(`
      DELETE FROM seasons
      WHERE id = ? AND group_id = ? AND completed = 0 AND revision = ? AND active_draw_id IS NULL
    `).bind(id, groupId, revision).run();
  if (!result.meta.changes) throw new ExchangeError(seasonChanged);
  return complete ? "Exchange completed." : "Undrawn exchange discarded.";
}

async function emailInvite(db: D1Database, group: Membership, form: FormData, origin: string) {
  const email = field(form, "email").toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ExchangeError("Enter a valid email address.");
  const id = crypto.randomUUID();
  const url = new URL("/join", origin);
  url.searchParams.set("code", group.code);

  const [, queued] = await db.batch([
    db.prepare("DELETE FROM invite_requests WHERE membership_id = ? AND queued_at <= unixepoch() - 900")
      .bind(group.membershipId),
    db.prepare(`
      INSERT INTO invite_requests(id, membership_id)
      SELECT ?, m.id FROM memberships m WHERE m.id = ?
      AND (SELECT count(*) FROM invite_requests WHERE membership_id = m.id) < 5
    `).bind(id, group.membershipId),
    db.prepare(`
      INSERT INTO email_outbox(event_key, kind, group_id, recipient, subject, body)
      SELECT 'invite:' || i.id, 'invite', m.group_id, ?, ?, ?
      FROM invite_requests i JOIN memberships m ON m.id = i.membership_id WHERE i.id = ?
    `).bind(email, "You’re invited to a gift exchange", `Join ${group.name}:\n\n${url}`, id),
  ]);
  if (!queued.meta.changes) throw new ExchangeError("The invitation limit has been reached. Try again in 15 minutes.");
  return "Invitation queued.";
}

export async function mutateExchange(db: D1Database, userId: string, form: FormData, origin: string, expectedMemberId?: string) {
  const group = await membership(db, userId);
  if (expectedMemberId !== undefined && group?.membershipId !== expectedMemberId) throw new MembershipChanged();
  if (!group) throw new ExchangeError("Join a group before managing an exchange.");
  const intent = field(form, "intent");
  if (intent === "invite") return emailInvite(db, group, form, origin);
  if (group.role !== "organizer") throw new ExchangeError("Only the organizer can make this change.");

  switch (intent) {
    case "start-season": return startSeason(db, group.groupId, validYear(field(form, "year")));
    case "set-roster": return setRoster(db, group.groupId, form);
    case "add-exclusion": return changeExclusion(db, group.groupId, form, true);
    case "remove-exclusion": return changeExclusion(db, group.groupId, form, false);
    case "draw": return publishDraw(db, group, form, origin);
    case "complete-season": return finishSeason(db, group.groupId, form, true);
    case "discard-season": return finishSeason(db, group.groupId, form, false);
    case "delete-group":
      requireConfirmation(form, "Confirm that you want to delete this group.");
      if (field(form, "groupId") !== group.groupId) {
        throw new ExchangeError("The group has changed. Review it before deleting.");
      }
      await db.batch([
        db.prepare("UPDATE email_outbox SET status = 'cancelled' WHERE group_id = ? AND status = 'pending'").bind(group.groupId),
        db.prepare("DELETE FROM groups WHERE id = ?").bind(group.groupId),
      ]);
      return "Group deleted.";
    default: throw new ExchangeError("Choose a valid exchange action.");
  }
}
