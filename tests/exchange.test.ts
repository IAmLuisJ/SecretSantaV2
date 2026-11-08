import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createGroup, getExchange, getInvite, joinGroup, mutateExchange } from "../app/server/exchange.ts";

const origin = "https://santa.example.test";
const users = ["alex", "blake", "casey", "devon", "erin", "outsider"];
const user = (id: string) => ({ id, email: `${id}@example.test` });

class Statement {
  readonly sql: string;
  private readonly sqlite: DatabaseSync;
  private readonly values: SQLInputValue[];
  constructor(sql: string, sqlite: DatabaseSync, values: SQLInputValue[] = []) {
    this.sql = sql;
    this.sqlite = sqlite;
    this.values = values;
  }
  bind(...values: SQLInputValue[]) { return new Statement(this.sql, this.sqlite, values); }
  async first() {
    const result = this.sqlite.prepare(this.sql).get(...this.values);
    return result ? { ...result } : null;
  }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
  async run() { return this.execute(); }
  execute() {
    const statement = this.sqlite.prepare(this.sql);
    return statement.columns().length > 0
      ? { results: statement.all(...this.values), meta: { changes: 0 } }
      : { results: [], meta: { changes: Number(statement.run(...this.values).changes) } };
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  onBatch?: (statements: Statement[]) => Promise<void>;
  constructor() {
    for (const file of ["0001_auth_mail.sql", "0002_exchange.sql"]) {
      this.sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const insert = this.sqlite.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)');
    for (const id of users) insert.run(id, id, user(id).email);
  }
  get db() { return this as unknown as D1Database; }
  prepare(sql: string) { return new Statement(sql, this.sqlite); }
  async batch(statements: Statement[]) {
    await this.onBatch?.(statements);
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  count(table: string, where = "1") {
    return this.sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`).get()?.total;
  }
}

function form(intent: string, fields: Record<string, string | number | string[]> = {}) {
  const data = new FormData();
  data.set("intent", intent);
  for (const [key, value] of Object.entries(fields)) {
    for (const element of Array.isArray(value) ? value : [value]) data.append(key, String(element));
  }
  return data;
}

async function setup(memberCount: number) {
  const fixture = new TestD1();
  const { db } = fixture;
  await createGroup(db, user("alex"), { name: "Family", description: "Annual gifts", year: 2026, displayName: "Alex" });
  const state = await getExchange(db, "alex");
  assert.ok(state?.season);
  for (const id of users.slice(1, memberCount)) await joinGroup(db, user(id), state.group.code, id);
  return fixture;
}

async function season(db: D1Database) {
  const state = await getExchange(db, "alex");
  assert.ok(state?.season);
  return state.season;
}

async function submission(db: D1Database, requestId = crypto.randomUUID(), confirm = "") {
  const current = await season(db);
  return form("draw", {
    seasonId: current.id,
    revision: current.revision,
    drawId: current.drawId ?? "",
    requestId,
    confirm,
  });
}

async function complete(db: D1Database) {
  const current = await season(db);
  assert.ok(current.drawId);
  return mutateExchange(db, "alex", form("complete-season", {
    seasonId: current.id, revision: current.revision, drawId: current.drawId, confirm: "yes",
  }), origin);
}

async function exclude(db: D1Database, first: string, second: string) {
  const state = await getExchange(db, "alex");
  const firstId = state?.members.find((member) => member.name.toLowerCase() === first)?.id;
  const secondId = state?.members.find((member) => member.name.toLowerCase() === second)?.id;
  assert.ok(firstId && secondId);
  await mutateExchange(db, "alex", form("add-exclusion", { firstId, secondId }), origin);
}

test("verified group enrollment is atomic and shows only permitted group information", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  const organizer = await getExchange(db, "alex");
  const member = await getExchange(db, "blake");
  assert.equal(organizer?.self.role, "organizer");
  assert.deepEqual(organizer?.members.map(({ name, eligible }) => [name, eligible]), [["Alex", true], ["blake", true]]);
  assert.equal(member?.self.role, "member");
  assert.deepEqual(member?.members, []);
  assert.equal(await getExchange(db, "outsider"), null);
  assert.ok(organizer);
  assert.deepEqual(await getInvite(db, organizer.group.code.toLowerCase()), {
    name: "Family", description: "Annual gifts", code: organizer.group.code,
  });
  assert.equal(fixture.count("email_outbox", "kind = 'welcome'"), 2);
  await assert.rejects(createGroup(db, user("blake"), { name: "Second", description: "", year: 2026, displayName: "Blake" }));
  await assert.rejects(mutateExchange(db, "blake", form("delete-group", { confirm: "yes" }), origin), /organizer/i);
  assert.equal(fixture.count("groups"), 1);
});

test("four adults keep a private draw across a skipped year with bidirectional exclusions and directed repeat prevention", async () => {
  const fixture = await setup(4);
  const { db } = fixture;
  await exclude(db, "alex", "blake");
  await mutateExchange(db, "alex", await submission(db), origin);
  const first = await Promise.all(users.slice(0, 4).map((id) => getExchange(db, id)));
  assert.equal(new Set(first.map((entry) => entry?.recipient?.id)).size, 4);
  assert.ok(first.every((entry) => entry?.recipient?.id !== entry?.self.id));
  assert.notEqual(first[0]?.recipient?.id, first[1]?.self.id);
  assert.notEqual(first[1]?.recipient?.id, first[0]?.self.id);
  assert.deepEqual(first[1]?.exclusions, []);
  await complete(db);
  assert.equal((await getExchange(db, "blake"))?.recipient?.id, first[1]?.recipient?.id);
  await mutateExchange(db, "alex", form("start-season", { year: 2028 }), origin);
  assert.equal((await getExchange(db, "blake"))?.recipient, null);
  await mutateExchange(db, "alex", await submission(db), origin);
  const next = await Promise.all(users.slice(0, 4).map((id) => getExchange(db, id)));
  assert.ok(next.every((entry, index) => entry?.recipient && entry.recipient.id !== first[index]?.recipient?.id));
  assert.notEqual(next[0]?.recipient?.id, next[1]?.self.id);
  assert.notEqual(next[1]?.recipient?.id, next[0]?.self.id);
  assert.equal(fixture.count("email_outbox", "kind = 'draw' AND status = 'pending'"), 4);
});

test("a failed redraw preserves assignments and delivery while a late joiner waits", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  await mutateExchange(db, "alex", await submission(db), origin);
  const state = await getExchange(db, "alex");
  assert.ok(state?.recipient);
  await joinGroup(db, user("casey"), state.group.code, "Casey");
  await exclude(db, "alex", "blake");
  await assert.rejects(mutateExchange(db, "alex", await submission(db), origin), /confirm/i);
  await assert.rejects(mutateExchange(db, "alex", await submission(db, crypto.randomUUID(), "yes"), origin), /no complete draw/i);
  assert.equal((await getExchange(db, "alex"))?.recipient?.id, state.recipient.id);
  assert.equal((await getExchange(db, "casey"))?.recipient, null);
  assert.equal((await getExchange(db, "alex"))?.waitingCount, 1);
  assert.equal(fixture.count("draws"), 1);
  assert.equal(fixture.count("assignments"), 2);
  assert.equal(fixture.count("email_outbox", "kind = 'draw' AND status = 'pending'"), 2);
});

test("a two-adult second season can be discarded and reused without losing completed history", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  await mutateExchange(db, "alex", await submission(db), origin);
  const first = await season(db);
  await complete(db);
  await mutateExchange(db, "alex", form("start-season", { year: 2027 }), origin);
  const current = await season(db);
  await assert.rejects(mutateExchange(db, "alex", await submission(db), origin), /no complete draw/i);
  await mutateExchange(db, "alex", form("discard-season", {
    seasonId: current.id, revision: current.revision, confirm: "yes",
  }), origin);
  assert.equal((await season(db)).id, first.id);
  assert.equal((await getExchange(db, "alex"))?.members.length, 2);
  assert.equal(fixture.count("assignments"), 2);
  await mutateExchange(db, "alex", form("start-season", { year: 2027 }), origin);
  assert.equal((await season(db)).year, 2027);
  await assert.rejects(mutateExchange(db, "alex", await submission(db), origin), /no complete draw/i);
});

test("only the final draw of the latest completed season prevents repeats", async (t) => {
  const fixture = await setup(3);
  const { db } = fixture;
  let order = 0.999;
  t.mock.method(Math, "random", () => order);
  await mutateExchange(db, "alex", await submission(db), origin);
  const original = (await getExchange(db, "alex"))?.recipient?.id;
  assert.ok(original);

  order = 0;
  await mutateExchange(db, "alex", await submission(db, crypto.randomUUID(), "yes"), origin);
  const replacement = (await getExchange(db, "alex"))?.recipient?.id;
  assert.ok(replacement && replacement !== original);
  assert.equal(fixture.count("email_outbox", "kind = 'draw' AND status = 'cancelled'"), 3);
  await complete(db);

  await mutateExchange(db, "alex", form("start-season", { year: 2027 }), origin);
  await mutateExchange(db, "alex", await submission(db), origin);
  assert.equal((await getExchange(db, "alex"))?.recipient?.id, original);
  await complete(db);

  await mutateExchange(db, "alex", form("start-season", { year: 2028 }), origin);
  await mutateExchange(db, "alex", await submission(db), origin);
  assert.equal((await getExchange(db, "alex"))?.recipient?.id, replacement);
});

test("the next season suggests the completed draw roster and keeps between-season joins available", async () => {
  const { db } = await setup(2);
  await mutateExchange(db, "alex", await submission(db), origin);
  await complete(db);
  const previous = await getExchange(db, "alex");
  assert.ok(previous?.season);
  await joinGroup(db, user("casey"), previous.group.code, "Casey");
  assert.equal((await season(db)).revision, previous.season.revision);
  await mutateExchange(db, "alex", form("start-season", { year: 2027 }), origin);
  assert.deepEqual(
    (await getExchange(db, "alex"))?.members.map(({ name, eligible }) => [name, eligible]),
    [["Alex", true], ["blake", true], ["Casey", false]],
  );
});

test("a roster edit racing publication leaves no partial assignments or emails", async () => {
  const fixture = await setup(3);
  const { db } = fixture;
  const request = await submission(db);
  const state = await getExchange(db, "alex");
  assert.ok(state?.season);
  const { members, season: current } = state;
  fixture.onBatch = async (statements) => {
    if (!statements.some(({ sql }) => /INSERT INTO draws/i.test(sql))) return;
    fixture.onBatch = undefined;
    await mutateExchange(db, "alex", form("set-roster", {
      seasonId: current.id, revision: current.revision, memberId: members.slice(0, 2).map(({ id }) => id),
    }), origin);
  };
  await assert.rejects(mutateExchange(db, "alex", request, origin), /changed/i);
  assert.equal(fixture.count("draws"), 0);
  assert.equal(fixture.count("assignments"), 0);
  assert.equal(fixture.count("email_outbox", "kind = 'draw'"), 0);
  assert.equal((await getExchange(db, "alex"))?.members.filter(({ eligible }) => eligible).length, 2);
});

test("an exclusion edit invalidates stale completion but leaves the current draw available", async () => {
  const fixture = await setup(3);
  const { db } = fixture;
  await mutateExchange(db, "alex", await submission(db), origin);
  const current = await season(db);
  assert.ok(current.drawId);
  await exclude(db, "alex", "blake");
  await assert.rejects(mutateExchange(db, "alex", form("complete-season", {
    seasonId: current.id, revision: current.revision, drawId: current.drawId, confirm: "yes",
  }), origin), /changed/i);
  assert.equal((await season(db)).completed, false);
  assert.equal((await season(db)).drawId, current.drawId);
});

test("concurrent draws only publish once and retried request keys do not duplicate mail", async () => {
  const fixture = await setup(3);
  const { db } = fixture;
  const first = await submission(db);
  const second = await submission(db);
  const published = await Promise.allSettled([
    mutateExchange(db, "alex", first, origin),
    mutateExchange(db, "alex", second, origin),
  ]);
  assert.equal(published.filter(({ status }) => status === "fulfilled").length, 1);
  await mutateExchange(db, "alex", published[0].status === "fulfilled" ? first : second, origin);
  assert.equal(fixture.count("draws"), 1);
  assert.equal(fixture.count("assignments"), 3);
  assert.equal(fixture.count("email_outbox", "kind = 'draw'"), 3);
});

test("group deletion cancels pending mail and frees the verified account for another group", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  await mutateExchange(db, "alex", await submission(db), origin);
  await mutateExchange(db, "blake", form("invite", { email: "another@example.test" }), origin);
  const oldGroup = (await getExchange(db, "alex"))!.group.id;
  await mutateExchange(db, "alex", form("delete-group", { groupId: oldGroup, confirm: "yes" }), origin);
  assert.equal(await getExchange(db, "blake"), null);
  assert.equal(fixture.count("assignments"), 0);
  assert.equal(fixture.count("email_outbox", "status = 'pending'"), 0);
  assert.equal(fixture.count("email_outbox", "status = 'cancelled'"), 5);
  await createGroup(db, user("blake"), { name: "Second", description: "", year: 2027, displayName: "Blake" });
  assert.equal((await getExchange(db, "blake"))?.group.name, "Second");
  await createGroup(db, user("alex"), { name: "New group", description: "", year: 2027, displayName: "Alex" });
  await assert.rejects(mutateExchange(db, "alex", form("delete-group", { groupId: oldGroup, confirm: "yes" }), origin), /group has changed/i);
  assert.equal((await getExchange(db, "alex"))?.group.name, "New group");
});

test("concurrent email invitations share a per-member limit", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  const invites = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    mutateExchange(db, "blake", form("invite", { email: `friend${index}@example.test` }), origin)));
  assert.equal(invites.filter(({ status }) => status === "fulfilled").length, 5);
  assert.equal(fixture.count("email_outbox", "kind = 'invite'"), 5);
});

test("local D1 rolls back stale publication after a roster edit races its input read", async (t) => {
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "exchange-test",
      compatibilityDate: "2026-11-07",
      env: { DB: { type: "d1", id: "exchange-test-db" } },
      manifest: {
        mainModule: "index.js",
        modules: { "index.js": { type: "esm", contents: "export default {}" } },
      },
    } }],
  });
  t.after(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  for (const file of ["0001_auth_mail.sql", "0002_exchange.sql"]) {
    const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
    const statements = sql.split(/;\n(?!END;)/).filter((statement) => statement.trim());
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
  await db.batch(users.slice(0, 3).map((id) => db.prepare(`
    INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)
  `).bind(id, id, user(id).email)));
  await createGroup(db, user("alex"), { name: "Family", description: "", year: 2026, displayName: "Alex" });
  const initial = await getExchange(db, "alex");
  assert.ok(initial);
  await joinGroup(db, user("blake"), initial.group.code, "Blake");
  await joinGroup(db, user("casey"), initial.group.code, "Casey");
  const state = await getExchange(db, "alex");
  assert.ok(state?.season);
  const current = state.season;

  let editBeforePublishing = true;
  const racingDb = new Proxy(db, {
    get(target, property) {
      if (property !== "batch") return Reflect.get(target, property, target);
      return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch(statements);
        if (editBeforePublishing) {
          // The draw has loaded its input snapshot and has yet to submit publication.
          editBeforePublishing = false;
          await mutateExchange(db, "alex", form("set-roster", {
            seasonId: current.id, revision: current.revision, memberId: state.members.slice(0, 2).map(({ id }) => id),
          }), origin);
        }
        return results;
      };
    },
  });
  await assert.rejects(mutateExchange(racingDb, "alex", await submission(db), origin), /changed/i);
  assert.equal(await db.prepare("SELECT count(*) AS total FROM assignments").first("total"), 0);
  assert.equal(await db.prepare("SELECT count(*) AS total FROM email_outbox WHERE kind = 'draw'").first("total"), 0);
  await mutateExchange(db, "alex", await submission(db), origin);
  assert.equal(await db.prepare("SELECT count(*) AS total FROM assignments").first("total"), 2);
});
