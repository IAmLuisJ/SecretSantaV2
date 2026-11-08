import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { Miniflare } from "miniflare";
import type { Env } from "../app/env.ts";
import { processOutbox } from "../app/server/mail.ts";

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
  await DB.batch([
    DB.prepare("CREATE TABLE groups (id TEXT PRIMARY KEY)"),
    DB.prepare("CREATE TABLE seasons (id TEXT PRIMARY KEY, group_id TEXT, year INTEGER, active_draw_id TEXT)"),
    DB.prepare("INSERT INTO groups VALUES ('group')"),
    DB.prepare("INSERT INTO seasons VALUES ('season','group',2026,'current')"),
  ]);
  const env = {
    DB,
    APP_ORIGIN: "https://santa.example.test",
    RESEND_API_KEY: "test-mail-key",
    MAIL_FROM: "Santa <santa@example.test>",
  } as unknown as Env;

  const job = async (key: string, group = "group", draw?: string) => {
    await DB.prepare(`
      INSERT INTO email_outbox (event_key, kind, group_id, draw_id, recipient, subject, body)
      VALUES (?, ?, ?, ?, 'member@example.test', 'Gift exchange', 'Sign in to see the exchange.')
    `).bind(key, draw ? "draw" : "welcome", group, draw ?? null).run();
  };
  const status = (key: string) => DB.prepare("SELECT status FROM email_outbox WHERE event_key = ?")
    .bind(key).first("status");

  const sends: Array<{ key: string | null; body: string }> = [];
  const intercept = (provider: () => Promise<Response> | Response) => {
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (input !== "https://api.resend.com/emails") return realFetch(input, init);
      sends.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: String(init?.body) });
      return provider();
    });
  };
  return { env, job, status, sends, intercept };
}

test("overlapping outbox processors claim each job once", async (t) => {
  const { env, job, status, sends, intercept } = await setup(t);
  await job("welcome:group:member");
  let start!: () => void;
  let deliver!: (response: Response) => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const inFlight = new Promise<Response>((resolve) => { deliver = resolve; });
  intercept(() => {
    start();
    return inFlight;
  });

  const first = processOutbox(env);
  await Promise.race([
    started,
    first.then(() => { throw new Error("Outbox exited before contacting the provider"); }),
  ]);
  try {
    await processOutbox(env);
    assert.equal(sends.length, 1);
    assert.ok(sends[0]?.key);
    assert.deepEqual(JSON.parse(sends[0].body), {
      from: env.MAIL_FROM,
      to: ["member@example.test"],
      subject: "Gift exchange",
      text: "Sign in to see the exchange.",
    });
  } finally {
    deliver(Response.json({ id: "message-1" }));
    await first;
  }
  assert.equal(await status("welcome:group:member"), "sent");
});

test("an ambiguous send retries with the same idempotency key and payload", async (t) => {
  const { env, job, status, sends, intercept } = await setup(t);
  await job("welcome:group:member");
  let calls = 0;
  intercept(() => {
    if (++calls === 1) throw new Error("Connection lost after request");
    return Response.json({ id: "message-1" });
  });

  await processOutbox(env);
  assert.equal(await status("welcome:group:member"), "pending");
  await processOutbox(env);
  assert.equal(sends.length, 1);
  await env.DB.prepare("UPDATE email_outbox SET next_attempt_at = unixepoch() - 1").run();
  await processOutbox({ ...env, MAIL_FROM: "Gift Exchange <new-sender@example.test>" });
  assert.equal(sends.length, 2);
  assert.ok(sends[0]?.key);
  assert.deepEqual(sends[0], sends[1]);
  assert.equal(await status("welcome:group:member"), "sent");
});

test("an ambiguous attempt beyond Resend's idempotency window is terminal", async (t) => {
  const { env, job, status, sends, intercept } = await setup(t);
  await job("welcome:group:member");
  await env.DB.prepare("UPDATE email_outbox SET first_attempt_at = unixepoch() - 90000, attempts = 1").run();
  intercept(() => Response.json({ id: "unexpected" }));
  await processOutbox(env);
  assert.equal(await status("welcome:group:member"), "failed");
  assert.equal(sends.length, 0);
});

test("deleted groups, superseded draws, and draws from earlier seasons are cancelled", async (t) => {
  const { env, job, status, sends, intercept } = await setup(t);
  await job("deleted-group", "deleted");
  await job("redrawn", "group", "superseded");
  await job("last-season", "group", "previous");
  await job("active", "group", "current");
  await env.DB.prepare("INSERT INTO seasons VALUES ('older','group',2025,'previous')").run();
  intercept(() => Response.json({ id: "message-1" }));
  await processOutbox(env);
  assert.equal(await status("deleted-group"), "cancelled");
  assert.equal(await status("redrawn"), "cancelled");
  assert.equal(await status("last-season"), "cancelled");
  assert.equal(await status("active"), "sent");
  assert.equal(sends.length, 1);
});

test("Resend validation failures are terminal and store no provider message", async (t) => {
  const { env, job, status, sends, intercept } = await setup(t);
  await job("invalid");
  intercept(() => Response.json({
    statusCode: 422,
    name: "validation_error",
    message: "Invalid recipient member@example.test",
  }, { status: 422 }));
  await processOutbox(env);
  assert.equal(await status("invalid"), "failed");
  assert.equal(sends.length, 1);
  const error = await env.DB.prepare("SELECT last_error FROM email_outbox WHERE event_key = 'invalid'")
    .first<string>("last_error");
  assert.ok(error);
  assert.ok(!error.includes("member@example.test"));
});
