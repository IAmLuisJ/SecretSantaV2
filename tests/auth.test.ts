import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { Miniflare } from "miniflare";
import type { Env } from "../app/env.ts";
import { getAuth, handleAuth } from "../app/server/auth.ts";

const origin = "https://santa.example.test";
const sendPath = "/api/auth/email-otp/send-verification-otp";
const verifyPath = "/api/auth/sign-in/email-otp";

async function setup(t: TestContext) {
  const miniflare = new Miniflare({
    workers: [{ config: {
      name: "test",
      compatibilityDate: "2026-11-07",
      env: { DB: { type: "d1", id: "test-db" } },
      manifest: {
        mainModule: "index.js",
        modules: { "index.js": { type: "esm", contents: "export default {}" } },
      },
    } }],
  });
  t.after(() => miniflare.dispose());
  const DB = await miniflare.getD1Database("DB");
  const sql = await readFile(new URL("../migrations/0001_auth_mail.sql", import.meta.url), "utf8");
  await DB.batch(sql.split(";").filter((statement) => statement.trim()).map((statement) => DB.prepare(statement)));
  const env = {
    DB,
    APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: "a-synthetic-better-auth-test-secret-with-entropy",
    RESEND_API_KEY: "test-mail-key",
    MAIL_FROM: "Santa <santa@example.test>",
  } as unknown as Env;

  const sent: Array<{ to: string[]; text: string }> = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (input !== "https://api.resend.com/emails") return realFetch(input, init);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: crypto.randomUUID() });
  });

  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    handleAuth(new Request(origin + path, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.1",
        ...headers,
      },
      body: JSON.stringify(body),
    }), env);

  return { env, post, sent };
}

test("a sign-in code is hashed at rest and only one racing verification can create a session", async (t) => {
  const { env, post, sent } = await setup(t);
  const email = "member@example.test";
  const send = await post(sendPath, { email: "  MEMBER@example.test ", type: "sign-in" });
  assert.equal(send.status, 200);
  assert.deepEqual(sent[0]?.to, [email]);
  const code = sent[0]?.text.match(/\b[0-9]{6}\b/)?.[0];
  assert.ok(code);

  const stored = await env.DB.prepare("SELECT value FROM verification").first<string>("value");
  assert.ok(stored);
  assert.notEqual(stored.split(":")[0], code);

  const verifications = await Promise.all([
    post(verifyPath, { email, otp: code }),
    post(verifyPath, { email, otp: code }),
  ]);
  const successes = verifications.filter((response) => response.ok);
  assert.equal(successes.length, 1);
  const sessionCookie = successes[0]?.headers.getSetCookie().find((cookie) => cookie.includes("session_token="));
  assert.ok(sessionCookie);
  assert.match(sessionCookie, /^__Secure-/);
  assert.match(sessionCookie, /;\s*Secure\b/i);
  assert.match(sessionCookie, /;\s*HttpOnly\b/i);
  assert.match(sessionCookie, /;\s*SameSite=Lax\b/i);

  const auth = getAuth(env, origin);
  const { explicitSchemaCheck } = await auth.$context;
  assert.ok(explicitSchemaCheck);
  await explicitSchemaCheck();
  const cookie = sessionCookie.split(";")[0];
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.equal(session?.user.email, email);
  assert.equal(session?.user.emailVerified, true);
  const forged = await auth.api.getSession({ headers: new Headers({ cookie: cookie + "forged" }) });
  assert.equal(forged, null);
  assert.equal((await post("/api/auth/sign-out", {}, { cookie })).status, 200);
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
});

test("existing and new accounts get the same response to valid code requests", async (t) => {
  const { env, post, sent } = await setup(t);
  await env.DB.prepare(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('member', 'Member', 'member@example.test', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run();
  const existing = await post(sendPath, { email: "member@example.test", type: "sign-in" });
  const fresh = await post(sendPath, { email: "new@example.test", type: "sign-in" });
  assert.equal(existing.status, 200);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await existing.json(), await fresh.json());
  assert.equal(sent.length, 2);
});

test("the persisted email quota follows normalized addresses across IPs", async (t) => {
  const { post, sent } = await setup(t);
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) => post(sendPath, {
    email: index % 2 === 0 ? "member@example.test" : " MEMBER@EXAMPLE.TEST ",
    type: "sign-in",
  }, { "cf-connecting-ip": `192.0.2.${index + 1}` })));
  assert.equal(attempts.filter((response) => response.status === 200).length, 1);
  assert.equal(attempts.filter((response) => response.status === 429).length, 7);
  assert.equal(sent.length, 1);
});

test("an address remains limited after its individual resend cooldown ends", async (t) => {
  const { env, post, sent } = await setup(t);
  for (let index = 0; index < 4; index++) {
    assert.equal((await post(sendPath, { email: "member@example.test", type: "sign-in" })).status, 200);
    await env.DB.prepare("UPDATE auth_rate_limits SET next_allowed_at = 0").run();
  }
  assert.equal((await post(sendPath, { email: "member@example.test", type: "sign-in" })).status, 429);
  assert.equal(sent.length, 4);
});

test("forged proxy headers cannot rotate the Cloudflare IP quota", async (t) => {
  const { post, sent } = await setup(t);
  const attempts = await Promise.all(Array.from({ length: 22 }, (_, index) => post(sendPath, {
    email: `member${index}@example.test`,
    type: "sign-in",
  }, { "x-forwarded-for": `198.51.100.${index + 1}` })));
  assert.equal(attempts.filter((response) => response.status === 200).length, 20);
  assert.equal(attempts.filter((response) => response.status === 429).length, 2);
  assert.equal(sent.length, 20);
});

test("untrusted origins and unused Better Auth actions cannot send OTPs", async (t) => {
  const { post, sent, env } = await setup(t);
  const body = { email: "member@example.test", type: "sign-in" };
  assert.equal((await post(sendPath, body, { origin: "https://evil.example.test" })).status, 403);
  assert.equal((await post("/api/auth/email-otp/check-verification-otp", body)).status, 404);
  assert.equal((await post(sendPath, { ...body, type: "email-verification" })).status, 400);
  const response = await handleAuth(new Request("https://evil.example.test" + sendPath, {
    method: "POST",
    headers: { origin: "https://evil.example.test" },
  }), { ...env, APP_ORIGIN: undefined, LOCAL_MAIL: "log" });
  assert.equal(response.status, 403);
  assert.equal(sent.length, 0);
});

test("expired codes cannot create an account or session", async (t) => {
  const { env, post, sent } = await setup(t);
  const email = "member@example.test";
  assert.equal((await post(sendPath, { email, type: "sign-in" })).status, 200);
  const otp = sent[0]?.text.match(/\b[0-9]{6}\b/)?.[0];
  assert.ok(otp);
  await env.DB.prepare("UPDATE verification SET expiresAt = '2020-01-01T00:00:00.000Z'").run();
  assert.equal((await post(verifyPath, { email, otp })).status, 400);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS count FROM user").first("count"), 0);
});

test("a delivery failure returns a generic unavailable response", async (t) => {
  const { env } = await setup(t);
  const response = await handleAuth(new Request(origin + sendPath, {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "member@example.test", type: "sign-in" }),
  }), { ...env, RESEND_API_KEY: undefined, LOCAL_MAIL: "log" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { message: "Sign-in is temporarily unavailable." });
});
