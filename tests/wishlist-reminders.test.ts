import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { RouterContextProvider } from "react-router";
import { hashPassword } from "better-auth/crypto";
import { test, vi, type TestContext } from "vitest";
import { workerContext } from "../app/context.ts";
import type { Env } from "../app/env.ts";
import { action as unsubscribeAction, loader as unsubscribeLoader } from "../app/routes/wishlist-reminders-unsubscribe.tsx";
import { action as preferencesAction, loader as preferencesLoader } from "../app/routes/wishlist-reminders.tsx";
import { processOutbox } from "../app/server/mail.ts";
import { getAuth } from "../app/server/auth.ts";
import { getReminderPreference, queueWishlistReminders, setReminderPreference, unsubscribeFromReminders, validateUnsubscribeLink } from "../app/server/wishlist-reminders.ts";

class Statement {
  constructor(readonly sqlite: DatabaseSync, readonly sql: string, readonly values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.sqlite, this.sql, values); }
  async first(column?: string) {
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    return row ? column ? row[column] : { ...row } : null;
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  execute() {
    const statement = this.sqlite.prepare(this.sql);
    return statement.columns().length
      ? { results: statement.all(...this.values), meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(statement.run(...this.values).changes) } };
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  constructor(t: TestContext) { t.onTestFinished(() => this.sqlite.close()); }
  get db() {
    return {
      prepare: (sql: string) => this.prepare(sql),
      batch: (statements: Statement[]) => this.batch(statements),
      exec: async (sql: string) => { this.sqlite.exec(sql); return { count: 0, duration: 0 }; },
    } as unknown as D1Database;
  }
  prepare(sql: string) { return new Statement(this.sqlite, sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map(statement => statement.execute());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  migrate(files: string[]) {
    for (const file of files) {
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      this.sqlite.exec("BEGIN");
      try {
        this.sqlite.exec(sql);
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

const migrations = () => readdirSync(new URL("../migrations/", import.meta.url))
  .filter(file => file.endsWith(".sql")).sort();

test("the reminder migration preserves queued mail and timestamps existing and new draws", async (t) => {
  const fixture = new TestD1(t);
  fixture.migrate(migrations().filter(file => file < "0010"));
  const { sqlite } = fixture;
  sqlite.exec(`
    INSERT INTO groups VALUES ('family', 'Family', '', 'ABCDEFGHIJKLMNOP');
    INSERT INTO seasons (id, group_id, year) VALUES ('season', 'family', 2026);
    INSERT INTO draws (id, group_id, season_id, revision, request_key)
      VALUES ('before', 'family', 'season', 0, 'before');
    INSERT INTO email_outbox (event_key, kind, group_id, recipient, subject, body, attempts, first_attempt_at, lease_token)
      VALUES ('existing', 'welcome', 'family', 'a@example.test', 'Hello', 'Welcome', 2, 123, 'lease');
  `);
  fixture.migrate(migrations().filter(file => file >= "0010"));
  const previous = await fixture.prepare("SELECT created_at FROM draws WHERE id = 'before'").first("created_at");
  assert.ok(Number(previous) > 0);
  sqlite.exec(`INSERT INTO draws (id, group_id, season_id, revision, request_key)
    VALUES ('after', 'family', 'season', 0, 'after')`);
  assert.ok(Number(await fixture.prepare("SELECT created_at FROM draws WHERE id = 'after'").first("created_at")) > 0);
  assert.deepEqual(await fixture.prepare("SELECT status, attempts, first_attempt_at, lease_token FROM email_outbox WHERE event_key = 'existing'").first(), {
    status: "pending", attempts: 2, first_attempt_at: 123, lease_token: "lease",
  });
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

function setup(t: TestContext) {
  const fixture = new TestD1(t);
  fixture.migrate(migrations());
  fixture.sqlite.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('alex', 'Alex', 'alex@example.test', 1, '2026-01-01', '2026-01-01'),
      ('blake', 'Blake', 'blake@example.test', 1, '2026-01-01', '2026-01-01'),
      ('casey', 'Casey', 'casey@example.test', 1, '2026-01-01', '2026-01-01');
    INSERT INTO groups VALUES ('family', 'Family', '', 'ABCDEFGHIJKLMNOP');
    INSERT INTO memberships VALUES
      ('a', 'family', 'alex', 'alex@example.test', 'Alex', 'organizer'),
      ('b', 'family', 'blake', 'blake@example.test', 'Blake', 'member'),
      ('c', 'family', 'casey', 'casey@example.test', 'Casey', 'member');
    INSERT INTO seasons (id, group_id, year) VALUES ('season', 'family', 2026);
    INSERT INTO season_participants (group_id, season_id, membership_id) VALUES
      ('family', 'season', 'a'), ('family', 'season', 'b'), ('family', 'season', 'c');
    INSERT INTO draws (id, group_id, season_id, revision, request_key)
      VALUES ('draw', 'family', 'season', 0, 'draw');
    UPDATE draws SET created_at = unixepoch() - 86401;
    INSERT INTO assignments (draw_id, season_id, giver_id, recipient_id) VALUES
      ('draw', 'season', 'a', 'b'), ('draw', 'season', 'b', 'a');
    UPDATE seasons SET active_draw_id = 'draw';
  `);
  const env = {
    DB: fixture.db, APP_ORIGIN: "https://santa.example.test",
    BETTER_AUTH_SECRET: "synthetic-reminder-test-secret-with-entropy",
    RESEND_API_KEY: "synthetic-resend-key", MAIL_FROM: "Santa <santa@example.test>",
  } as Env;
  const rows = () => fixture.sqlite.prepare("SELECT * FROM email_outbox WHERE kind = 'wishlist-reminder' ORDER BY reminder_member_id, created_at").all();
  const addWish = (memberId = "a") => fixture.sqlite.prepare(`
    INSERT INTO gift_items (id, group_id, owner_id, name, description, url, created_at)
    VALUES (?, 'family', ?, 'A book', '', '', unixepoch())
  `).run(crypto.randomUUID(), memberId);
  const sends: Array<{ to: string[]; text: string; headers?: Record<string, string> }> = [];
  const intercept = (provider: () => Response = () => Response.json({ id: crypto.randomUUID() })) => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input !== "https://api.resend.com/emails") return realFetch(input, init);
      sends.push(JSON.parse(String(init?.body)));
      return provider();
    });
  };
  return { fixture, sqlite: fixture.sqlite, env, rows, addWish, sends, intercept };
}

test("only matched adults with an empty wishlist receive reminders, with private links", async (t) => {
  const { env, rows, addWish, intercept, sends } = setup(t);
  addWish("b");
  assert.equal(await queueWishlistReminders(env), 1);
  const [job] = rows();
  assert.equal(job?.recipient, "alex@example.test");
  assert.match(String(job?.body), /https:\/\/santa\.example\.test\/exchange\/family#wish-list/);
  assert.match(String(job?.body), /Stop wishlist reminders for all my exchanges/);
  assert.doesNotMatch(String(job?.body), /Blake|Casey|blake@example/);
  intercept();
  await processOutbox(env);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.headers?.["List-Unsubscribe"], `<${job?.unsubscribe_url}>`);
  assert.equal(sends[0]?.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("the first reminder waits a day after the draw releases", async (t) => {
  const { env, sqlite, rows } = setup(t);
  sqlite.exec("UPDATE draws SET created_at = unixepoch()");
  assert.equal(await queueWishlistReminders(env), 0);
  sqlite.exec("UPDATE draws SET release_at = unixepoch() - 200000");
  assert.equal(await queueWishlistReminders(env), 0, "an existing released draw gets a grace period after migration");
  sqlite.exec("UPDATE draws SET created_at = unixepoch() - 200000, release_at = unixepoch() + 3600");
  assert.equal(await queueWishlistReminders(env), 0);
  sqlite.exec("UPDATE draws SET release_at = unixepoch() - 3600");
  assert.equal(await queueWishlistReminders(env), 0);
  sqlite.exec("UPDATE draws SET release_at = unixepoch() - 86401");
  assert.equal(await queueWishlistReminders(env), 2);
  assert.equal(rows().length, 2);
});

test("overlapping schedulers do not duplicate reminders, and repeats wait three days after delivery", async (t) => {
  const { env, sqlite, rows, intercept } = setup(t);
  await Promise.all([queueWishlistReminders(env), queueWishlistReminders(env)]);
  assert.equal(rows().length, 2);
  intercept();
  await processOutbox(env);
  assert.equal(await queueWishlistReminders(env), 0);
  sqlite.exec("UPDATE email_outbox SET created_at = unixepoch() - 259201, first_attempt_at = unixepoch() - 259201");
  assert.equal(await queueWishlistReminders(env), 0, "a delayed successful send starts its own cooldown");
  sqlite.exec("UPDATE email_outbox SET sent_at = unixepoch() - 259201");
  assert.equal(await queueWishlistReminders(env), 2);
  assert.equal(rows().length, 4);
  assert.equal(await queueWishlistReminders(env), 0);
});

for (const status of ["pending", "sent", "cancelled"] as const) {
  test(`a redraw's first reminders are not delayed by ${status} reminders from its previous draw`, async (t) => {
    const { env, sqlite, rows } = setup(t);
    assert.equal(await queueWishlistReminders(env), 2);
    sqlite.prepare("UPDATE email_outbox SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN unixepoch() END")
      .run(status, status);
    sqlite.exec(`
      INSERT INTO draws (id, group_id, season_id, revision, request_key)
        VALUES ('redraw', 'family', 'season', 0, 'redraw');
      UPDATE draws SET created_at = unixepoch() - 86401 WHERE id = 'redraw';
      INSERT INTO assignments (draw_id, season_id, giver_id, recipient_id) VALUES
        ('redraw', 'season', 'a', 'b'), ('redraw', 'season', 'b', 'a');
      UPDATE seasons SET active_draw_id = 'redraw';
    `);
    assert.equal(await queueWishlistReminders(env), 2);
    assert.equal(rows().filter(row => row.draw_id === "redraw").length, 2);
    assert.equal(await queueWishlistReminders(env), 0);
  });
}

test("opt-out is account-wide, cancels queued reminders, and can be reversed", async (t) => {
  const { env, sqlite, rows } = setup(t);
  sqlite.exec(`
    INSERT INTO groups VALUES ('friends', 'Friends', '', 'QRSTUVWXYZABCDEF');
    INSERT INTO memberships VALUES
      ('a2', 'friends', 'alex', 'alex@example.test', 'Alex', 'organizer'),
      ('b2', 'friends', 'blake', 'blake@example.test', 'Blake', 'member');
    INSERT INTO seasons (id, group_id, year) VALUES ('season2', 'friends', 2026);
    INSERT INTO season_participants (group_id, season_id, membership_id) VALUES
      ('friends', 'season2', 'a2'), ('friends', 'season2', 'b2');
    INSERT INTO draws (id, group_id, season_id, revision, request_key)
      VALUES ('draw2', 'friends', 'season2', 0, 'draw2');
    UPDATE draws SET created_at = unixepoch() - 86401;
    INSERT INTO assignments (draw_id, season_id, giver_id, recipient_id) VALUES
      ('draw2', 'season2', 'a2', 'b2'), ('draw2', 'season2', 'b2', 'a2');
    UPDATE seasons SET active_draw_id = 'draw2' WHERE id = 'season2';
  `);
  assert.equal(await getReminderPreference(env.DB, "alex"), true);
  await queueWishlistReminders(env);
  await setReminderPreference(env.DB, "alex", false);
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
  assert.equal(rows().find(row => row.reminder_member_id === "a")?.status, "cancelled");
  assert.equal(rows().find(row => row.reminder_member_id === "a2")?.status, "cancelled");
  sqlite.exec("UPDATE email_outbox SET created_at = unixepoch() - 259201, status = 'sent', sent_at = unixepoch() - 259201");
  assert.equal(await queueWishlistReminders(env), 2);
  await setReminderPreference(env.DB, "alex", true);
  assert.equal(await queueWishlistReminders(env), 2);
});

test("adding an item prevents delivery of already queued reminders", async (t) => {
  const { env, rows, addWish, intercept, sends } = setup(t);
  await queueWishlistReminders(env);
  addWish("a");
  intercept();
  await processOutbox(env);
  assert.equal(rows().find(row => row.reminder_member_id === "a")?.status, "cancelled");
  assert.deepEqual(sends.map(mail => mail.to), [["blake@example.test"]]);
});

for (const [label, change] of [
  ["completed exchange", "UPDATE seasons SET completed = 1"],
  ["superseded draw", `INSERT INTO draws (id, group_id, season_id, revision, request_key)
    VALUES ('redraw', 'family', 'season', 0, 'redraw'); UPDATE seasons SET active_draw_id = 'redraw'`],
  ["deleted group", "DELETE FROM groups"],
  ["unverified email", 'UPDATE "user" SET emailVerified = 0'],
  ["changed email", `UPDATE "user" SET email = 'new-' || email; UPDATE memberships SET email = 'new-' || email`],
] as const) {
  test(`a ${label} cancels queued reminders and prevents stale delivery`, async (t) => {
    const { env, sqlite, rows, intercept, sends } = setup(t);
    await queueWishlistReminders(env);
    sqlite.exec(change);
    intercept();
    await processOutbox(env);
    assert.equal(sends.length, 0);
    assert.ok(rows().every(row => row.status === "cancelled"));
  });
}

test("unsubscribe links cannot be forged or used for a different account, and do not need a login", async (t) => {
  const { env, rows } = setup(t);
  await queueWishlistReminders(env);
  const link = new URL(String(rows()[0]?.unsubscribe_url));
  assert.deepEqual(await validateUnsubscribeLink(env, link), { userId: "alex", enabled: true });
  assert.equal(await getReminderPreference(env.DB, "alex"), true, "opening an email link does not opt out");
  const forged = new URL(link);
  forged.searchParams.set("user", "blake");
  assert.equal(await validateUnsubscribeLink(env, forged), null);
  forged.searchParams.set("user", "alex");
  forged.searchParams.set("token", "0".repeat(64));
  assert.equal(await validateUnsubscribeLink(env, forged), null);
  assert.equal(await unsubscribeFromReminders(env, forged), false);
  assert.equal(await unsubscribeFromReminders(env, link), true);
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
  assert.equal(await unsubscribeFromReminders(env, link), true, "repeated unsubscribe requests are harmless");
  assert.equal(await getReminderPreference(env.DB, "blake"), true);
});

test("unverified accounts and unavailable mail do not produce reminder jobs", async (t) => {
  const { env, sqlite } = setup(t);
  assert.equal(await queueWishlistReminders({ ...env, RESEND_API_KEY: undefined }), 0);
  sqlite.exec('UPDATE "user" SET emailVerified = 0');
  assert.equal(await queueWishlistReminders(env), 0);
});

function routeArgs(env: Env, request: Request) {
  const context = new RouterContextProvider();
  context.set(workerContext, { env, executionContext: {} as ExecutionContext });
  return { request, url: new URL(request.url), context, params: {}, pattern: request.url };
}

test("HTTP unsubscribe previews on GET and supports sessionless email-client POSTs", async (t) => {
  const { env, rows } = setup(t);
  await queueWishlistReminders(env);
  const link = String(rows()[0]?.unsubscribe_url);
  const preview = await unsubscribeLoader(routeArgs(env, new Request(link)));
  assert.deepEqual(preview, { valid: true, enabled: true });
  assert.equal(await getReminderPreference(env.DB, "alex"), true);
  const response = await unsubscribeAction(routeArgs(env, new Request(link, {
    method: "POST", body: "List-Unsubscribe=One-Click",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  })));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
  assert.deepEqual(await unsubscribeLoader(routeArgs(env, new Request(link))), { valid: true, enabled: false });
});

test("the unsubscribe confirmation redirects back to its saved preference without a login", async (t) => {
  const { env, rows } = setup(t);
  await queueWishlistReminders(env);
  const link = String(rows()[0]?.unsubscribe_url);
  const response = await unsubscribeAction(routeArgs(env, new Request(link, {
    method: "POST", headers: { Origin: env.APP_ORIGIN! },
  })));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), new URL(link).pathname + new URL(link).search);
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
});

test("invalid unsubscribe requests leave preferences unchanged", async (t) => {
  const { env } = setup(t);
  const link = env.APP_ORIGIN + "/wishlist-reminders/unsubscribe?user=alex&token=invalid";
  assert.deepEqual(await unsubscribeLoader(routeArgs(env, new Request(link))), { valid: false, enabled: false });
  const response = await unsubscribeAction(routeArgs(env, new Request(link, { method: "POST" })));
  assert.equal(response.status, 400);
  assert.equal(await getReminderPreference(env.DB, "alex"), true);
});

test("unsubscribe changes are only accepted over POST", async (t) => {
  const { env, rows } = setup(t);
  await queueWishlistReminders(env);
  const response = await unsubscribeAction(routeArgs(env, new Request(String(rows()[0]?.unsubscribe_url), { method: "DELETE" })));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.equal(await getReminderPreference(env.DB, "alex"), true);
});

test("settings require a signed-in user before reading or changing preferences", async (t) => {
  const { env } = setup(t);
  const url = env.APP_ORIGIN + "/wishlist-reminders";
  const load = await preferencesLoader(routeArgs(env, new Request(url)));
  assert.ok(load instanceof Response);
  assert.equal(load.headers.get("Location"), "/?next=%2Fwishlist-reminders");
  const post = await preferencesAction(routeArgs(env, new Request(url, {
    method: "POST", body: "enabled=0&user=alex", headers: { Origin: env.APP_ORIGIN! },
  })));
  assert.ok(post instanceof Response);
  assert.equal(post.status, 303);
  assert.equal(await getReminderPreference(env.DB, "alex"), true);
});

test("a signed-in user can update only their own preference, and cross-site forms are rejected", async (t) => {
  const { env, sqlite } = setup(t);
  const password = "synthetic-settings-password";
  sqlite.prepare(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
    VALUES ('credential', 'alex', 'credential', 'alex', ?, '2026-01-01', '2026-01-01')`)
    .run(await hashPassword(password));
  const login = await getAuth(env, env.APP_ORIGIN!).api.signInEmail({
    body: { email: "alex@example.test", password }, asResponse: true,
    headers: new Headers({ Origin: env.APP_ORIGIN! }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().find(value => value.includes("session_token="))?.split(";")[0];
  assert.ok(cookie);
  const url = env.APP_ORIGIN + "/wishlist-reminders";
  assert.deepEqual(await preferencesLoader(routeArgs(env, new Request(url, { headers: { Cookie: cookie } }))), { enabled: true });
  const save = await preferencesAction(routeArgs(env, new Request(url, {
    method: "POST", body: "enabled=0&user=blake",
    headers: { Cookie: cookie, Origin: env.APP_ORIGIN!, "Content-Type": "application/x-www-form-urlencoded" },
  })));
  assert.deepEqual(save, { message: "Wishlist reminders are off for all your exchanges." });
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
  assert.equal(await getReminderPreference(env.DB, "blake"), true);
  await assert.rejects(preferencesAction(routeArgs(env, new Request(url, {
    method: "POST", body: "enabled=1",
    headers: { Cookie: cookie, Origin: "https://other.example.test", "Content-Type": "application/x-www-form-urlencoded" },
  }))), (error: unknown) => error instanceof Response && error.status === 403);
  assert.equal(await getReminderPreference(env.DB, "alex"), false);
});

test("reminder delivery retries preserve the payload and stop if the wishlist is filled", async (t) => {
  const { env, sqlite, rows, intercept, sends, addWish } = setup(t);
  intercept(() => Response.json({ name: "internal_error" }, { status: 500 }));
  await queueWishlistReminders(env);
  await processOutbox(env);
  assert.equal(sends.length, 2);
  sqlite.exec("UPDATE email_outbox SET next_attempt_at = unixepoch() - 1");
  await processOutbox(env);
  assert.deepEqual(sends.slice(2), sends.slice(0, 2));
  addWish("a");
  addWish("b");
  sqlite.exec("UPDATE email_outbox SET next_attempt_at = unixepoch() - 1");
  await processOutbox(env);
  assert.equal(sends.length, 4);
  assert.ok(rows().every(row => row.status === "cancelled"));
});
