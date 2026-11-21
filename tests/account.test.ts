import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { hashPassword } from "better-auth/crypto";
import { Miniflare } from "miniflare";
import { test, vi, type TestContext } from "vitest";
import type { Env } from "../app/env.ts";
import { confirmAccountCode, mergeWithPassword, sendAccountCode } from "../app/server/account.ts";
import { createGroup, getInvite, joinGroup, listExchanges } from "../app/server/exchange.ts";

const origin = "https://santa.example.test";
const request = new Request(`${origin}/account`, { headers: { "CF-Connecting-IP": "192.0.2.17" } });

async function setup(t: TestContext) {
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "test",
      compatibilityDate: "2026-11-07",
      env: { DB: { type: "d1", id: "account-test-db" } },
      manifest: {
        mainModule: "index.js",
        modules: { "index.js": { type: "esm", contents: "export default {}" } },
      },
    } }],
  });
  t.onTestFinished(() => runtime.dispose());
  const DB = await runtime.getD1Database("DB");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort()) {
    const sql = await readFile(new URL(file, migrations), "utf8");
    await DB.batch(sql.split(/;\n(?!END;)/).filter(statement => statement.trim()).map(statement => DB.prepare(statement)));
  }
  const env = {
    DB, APP_ORIGIN: origin, BETTER_AUTH_SECRET: "synthetic-account-test-secret-with-entropy",
    RESEND_API_KEY: "test-mail-key", MAIL_FROM: "Santa <santa@example.test>",
  } as unknown as Env;

  const sent: Array<{ to: string[]; text: string }> = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (input !== "https://api.resend.com/emails") return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: crypto.randomUUID() });
  });

  async function addSession(userId: string) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await DB.prepare(`
      INSERT INTO session (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, userId, crypto.randomUUID(), new Date(Date.now() + 600_000).toISOString(), now, now).run();
    return { id };
  }

  async function addUser(id: string, emailVerified = true) {
    const email = `${id}@example.test`;
    const now = new Date().toISOString();
    await DB.prepare(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, id, email, emailVerified, now, now).run();
    return { user: { id, email, emailVerified }, session: await addSession(id) };
  }

  return { DB, env, sent, addSession, addUser };
}

function codeFrom(mail: { text: string } | undefined) {
  const code = mail?.text.match(/confirmation code is (\d{6})/)?.[1];
  assert.ok(code);
  return code;
}

test("changing email keeps the account and sends queued exchange mail to the verified address", async (t) => {
  const { DB, env, sent, addSession, addUser } = await setup(t);
  const primary = await addUser("primary");
  const anotherSession = await addSession(primary.user.id);
  const groupId = await createGroup(DB, primary.user, { name: "Family", year: 2026, description: "", displayName: "Jess" });
  const challenge = await sendAccountCode(request, env, primary, "change-email", "  NEW@EXAMPLE.TEST ");
  assert.deepEqual(sent.at(-1)?.to, ["new@example.test"]);
  const code = codeFrom(sent.at(-1));

  const results = await Promise.allSettled([0, 1].map(() => confirmAccountCode(env, primary, "change-email", challenge, code)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.deepEqual(await DB.prepare('SELECT email, emailVerified FROM "user" WHERE id = ?').bind(primary.user.id).first(), {
    email: "new@example.test", emailVerified: 1,
  });
  assert.deepEqual(await listExchanges(DB, primary.user.id), [{ id: groupId, name: "Family", role: "organizer" }]);
  assert.equal(await DB.prepare("SELECT email FROM memberships WHERE group_id = ?").bind(groupId).first("email"), "new@example.test");
  assert.equal(await DB.prepare("SELECT recipient FROM email_outbox WHERE group_id = ?").bind(groupId).first("recipient"), "new@example.test");
  assert.equal(await DB.prepare("SELECT id FROM session WHERE id = ?").bind(anotherSession.id).first(), null);
  assert.equal(await DB.prepare("SELECT id FROM session WHERE id = ?").bind(primary.session.id).first("id"), primary.session.id);
});

test("an email change cannot replace another account’s address", async (t) => {
  const { DB, env, sent, addUser } = await setup(t);
  const primary = await addUser("primary");
  const other = await addUser("other");
  const challenge = await sendAccountCode(request, env, primary, "change-email", other.user.email);
  await assert.rejects(confirmAccountCode(env, primary, "change-email", challenge, codeFrom(sent.at(-1))), { status: 409 });
  assert.equal(await DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(primary.user.id).first("email"), primary.user.email);
  assert.equal(await DB.prepare('SELECT id FROM "user" WHERE email = ?').bind(other.user.email).first("id"), other.user.id);
});

test("an email change requires an address that the sign-in form accepts", async (t) => {
  const { env, sent, addUser } = await setup(t);
  const primary = await addUser("primary");
  await assert.rejects(sendAccountCode(request, env, primary, "change-email", "north!pole@example.test"), { status: 400 });
  assert.equal(sent.length, 0);
});

test("merging preserves the other account’s membership ID and invalidates its sessions", async (t) => {
  const { DB, env, sent, addUser } = await setup(t);
  const primary = await addUser("primary");
  const other = await addUser("other");
  const family = await createGroup(DB, primary.user, { name: "Family", year: 2026, description: "", displayName: "Jess" });
  const friends = await createGroup(DB, other.user, { name: "Friends", year: 2026, description: "", displayName: "Jessie" });
  const membership = await DB.prepare("SELECT id FROM memberships WHERE group_id = ?").bind(friends).first("id");
  const challenge = await sendAccountCode(request, env, primary, "merge-accounts", other.user.email);

  await confirmAccountCode(env, primary, "merge-accounts", challenge, codeFrom(sent.at(-1)));
  assert.deepEqual(await listExchanges(DB, primary.user.id), [
    { id: family, name: "Family", role: "organizer" }, { id: friends, name: "Friends", role: "organizer" },
  ]);
  assert.deepEqual(await DB.prepare("SELECT id, name, email FROM memberships WHERE group_id = ?").bind(friends).first(), {
    id: membership, name: "Jessie", email: primary.user.email,
  });
  assert.equal(await DB.prepare("SELECT id FROM session WHERE id = ?").bind(other.session.id).first(), null);
  assert.equal(await DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(other.user.id).first(), null);
});

test("a shared exchange blocks the entire merge", async (t) => {
  const { DB, env, sent, addUser } = await setup(t);
  const primary = await addUser("primary");
  const other = await addUser("other");
  const family = await createGroup(DB, primary.user, { name: "Family", year: 2026, description: "", displayName: "Jess" });
  const code = await DB.prepare("SELECT code FROM groups WHERE id = ?").bind(family).first<string>("code");
  assert.ok(code && await getInvite(DB, code));
  await joinGroup(DB, other.user, code, "Jessie");
  const friends = await createGroup(DB, other.user, { name: "Friends", year: 2026, description: "", displayName: "Jessie" });
  const challenge = await sendAccountCode(request, env, primary, "merge-accounts", other.user.email);

  await assert.rejects(confirmAccountCode(env, primary, "merge-accounts", challenge, codeFrom(sent.at(-1))), { status: 409 });
  assert.deepEqual((await listExchanges(DB, primary.user.id)).map(group => group.id), [family]);
  assert.deepEqual((await listExchanges(DB, other.user.id)).map(group => group.id), [family, friends]);
  assert.equal(await DB.prepare("SELECT id FROM session WHERE id = ?").bind(other.session.id).first("id"), other.session.id);
});

test("an account code is bound to its session and operation and stops accepting guesses", async (t) => {
  const { env, sent, addUser, addSession } = await setup(t);
  const primary = await addUser("primary");
  const challenge = await sendAccountCode(request, env, primary, "change-email", "new@example.test");
  const code = codeFrom(sent.at(-1));
  const otherSession = { user: primary.user, session: await addSession(primary.user.id) };
  await assert.rejects(confirmAccountCode(env, otherSession, "change-email", challenge, code), { status: 400 });
  await assert.rejects(confirmAccountCode(env, primary, "merge-accounts", challenge, code), { status: 400 });
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(confirmAccountCode(env, primary, "change-email", challenge, wrong), { status: 400 });
  }
  await assert.rejects(confirmAccountCode(env, primary, "change-email", challenge, code), { status: 400 });
});

test("an unverified account can only be merged with its password", async (t) => {
  const { DB, env, sent, addUser } = await setup(t);
  const primary = await addUser("primary");
  const other = await addUser("other", false);
  const password = "synthetic test password";
  const hash = await hashPassword(password);
  await DB.prepare(`
    INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
    VALUES ('credential', ?, 'credential', ?, ?, '2026-11-01', '2026-11-01')
  `).bind(other.user.id, other.user.id, hash).run();
  const friends = await createGroup(DB, other.user, { name: "Friends", year: 2026, description: "", displayName: "Jessie" });
  const challenge = await sendAccountCode(request, env, primary, "merge-accounts", other.user.email);
  await assert.rejects(confirmAccountCode(env, primary, "merge-accounts", challenge, codeFrom(sent.at(-1))), { status: 409 });
  await assert.rejects(mergeWithPassword(request, env, primary, other.user.email, "wrong password"), { status: 401 });

  await mergeWithPassword(request, env, primary, other.user.email, password);
  assert.deepEqual(await listExchanges(DB, primary.user.id), [{ id: friends, name: "Friends", role: "organizer" }]);
  assert.equal(await DB.prepare("SELECT id FROM account WHERE userId = ?").bind(other.user.id).first(), null);
});
