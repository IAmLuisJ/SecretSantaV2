import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createGroup, getExchange as getGroupExchange, getInvite, joinGroup, listExchanges, mutateExchange as mutateGroupExchange } from "../app/server/exchange.ts";

const origin = "https://santa.example.test";
const users = ["alex", "blake", "casey", "devon", "erin", "outsider"];
const user = (id: string) => ({ id, email: `${id}@example.test` });
const multipleExchangesMigration = "0005_multiple_exchanges.sql";
const drawPartyMigration = "0006_draw_party.sql";
const migrations = [
  "0001_auth_mail.sql", "0002_exchange.sql", "0003_gifts.sql", "0004_codenames.sql",
  multipleExchangesMigration, drawPartyMigration,
];

async function getExchange(db: D1Database, userId: string) {
  const [group] = await listExchanges(db, userId);
  return group ? getGroupExchange(db, userId, group.id) : null;
}

async function mutateExchange(db: D1Database, userId: string, form: FormData, origin: string) {
  const [group] = await listExchanges(db, userId);
  assert.ok(group);
  return mutateGroupExchange(db, userId, group.id, form, origin);
}

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
  constructor(schema = migrations) {
    for (const file of schema) this.migrate(file);
    const insert = this.sqlite.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)');
    for (const id of users) insert.run(id, id, user(id).email);
  }
  migrate(file: string) {
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
  await assert.rejects(mutateExchange(db, "blake", form("delete-group", { confirm: "yes" }), origin), /organizer/i);
  assert.equal(fixture.count("groups"), 1);
});

test("the multiple-exchanges migration preserves existing draws, wishes, and membership data", async () => {
  const fixture = new TestD1(migrations.slice(0, migrations.indexOf(multipleExchangesMigration)));
  const { sqlite } = fixture;
  sqlite.exec(`
    INSERT INTO groups VALUES ('group', 'Family', '', 'AAAAAAAAAAAAAAAA');
    INSERT INTO memberships VALUES
      ('alice-id', 'group', 'alex', 'alex@example.test', 'Alex', 'organizer'),
      ('blake-id', 'group', 'blake', 'blake@example.test', 'Blake', 'member'),
      ('casey-id', 'group', 'casey', 'casey@example.test', 'Casey', 'member');
    INSERT INTO seasons (id, group_id, year, codename_mode) VALUES ('season', 'group', 2026, 1);
    INSERT INTO season_participants (group_id, season_id, membership_id)
      SELECT group_id, 'season', id FROM memberships;
    INSERT INTO pair_exclusions VALUES ('group', 'alice-id', 'blake-id');
    INSERT INTO draws VALUES ('draw', 'group', 'season', 1, 'request-key');
    INSERT INTO assignments VALUES ('draw', 'season', 'alice-id', 'casey-id', 'Detective Eggnog');
    UPDATE seasons SET active_draw_id = 'draw' WHERE id = 'season';
    INSERT INTO invite_requests (id, membership_id) VALUES ('invite', 'alice-id');
    INSERT INTO addresses VALUES ('alice-id', 'Alex', 'Example', '100 Test Lane', '', 'Detroit', 'MI', '48201');
    INSERT INTO children VALUES ('child', 'group', 'Robin', 6);
    INSERT INTO gift_items (id, group_id, owner_id, child_id, name, description, url, photo_key, created_at)
    VALUES ('adult-wish', 'group', 'alice-id', NULL, 'Scarf', '', '', 'photos/scarf', 0),
           ('child-wish', 'group', NULL, 'child', 'Train', '', '', 'photos/train', 0);
  `);
  const tables = ["memberships", "seasons", "season_participants", "draws", "assignments",
    "pair_exclusions", "invite_requests", "addresses", "children", "gift_items", "photo_cleanup"];
  const snapshot = () => tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort());
  const before = snapshot();
  fixture.migrate(multipleExchangesMigration);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => sqlite.exec(`
    INSERT INTO memberships VALUES ('duplicate', 'group', 'alex', 'alex@example.test', 'Alex', 'member')
  `), /UNIQUE/);
  sqlite.exec("DELETE FROM gift_items WHERE id = 'adult-wish'");
  assert.equal(fixture.count("photo_cleanup", "photo_key = 'photos/scarf'"), 1);

  fixture.migrate(drawPartyMigration);
  const exchange = await getGroupExchange(fixture.db, "alex", "group");
  assert.equal(exchange?.season?.drawReleaseAt, null);
  assert.equal(exchange?.recipient?.name, "Detective Eggnog");
});

test("the organizer can enable codenames before the draw and published aliases stay private and stable", async () => {
  const { db } = await setup(3);
  const current = await season(db);
  const settings = (enabled: number, revision: number) => form("set-codename-mode", {
    seasonId: current.id, revision, enabled,
  });
  await assert.rejects(mutateExchange(db, "blake", settings(1, current.revision), origin), /organizer/i);
  const staleDraw = await submission(db);
  await mutateExchange(db, "alex", settings(1, current.revision), origin);
  assert.equal((await season(db)).codenameMode, true);
  await assert.rejects(mutateExchange(db, "alex", staleDraw, origin), /changed/i);
  await mutateExchange(db, "alex", await submission(db), origin);

  const participants = users.slice(0, 3);
  const states = await Promise.all(participants.map((id) => getExchange(db, id)));
  const codenames = states.map((state) => state?.recipient?.name);
  assert.equal(new Set(codenames).size, participants.length);
  for (const name of codenames) {
    assert.ok(name);
    assert.ok(!participants.includes(name.toLowerCase()));
  }
  const published = await season(db);
  await assert.rejects(mutateExchange(db, "alex", settings(0, published.revision), origin), /first draw/i);
  assert.deepEqual(await Promise.all(participants.map(async (id) => (await getExchange(db, id))?.recipient?.name)), codenames);
});

test("a draw party holds matches, codenames, and notifications until its release second", async () => {
  const { db, sqlite } = await setup(2);
  const releaseAt = Date.parse("2026-12-20T23:00:00Z") / 1000;
  let now = releaseAt - 1;
  sqlite.function("unixepoch", () => now);

  const current = await season(db);
  await mutateExchange(db, "alex", form("set-codename-mode", {
    seasonId: current.id, revision: current.revision, enabled: 1,
  }), origin);
  const draw = await submission(db);
  draw.set("releaseTime", "2026-12-20T18:00");
  draw.set("releaseOffset", "300");
  await assert.rejects(mutateExchange(db, "blake", draw, origin), /organizer/i);
  await mutateExchange(db, "alex", draw, origin);

  const member = await getExchange(db, "blake");
  assert.ok(member?.season?.drawId);
  assert.equal(member.season.drawReleaseAt, releaseAt);
  assert.equal(member.recipient, null);
  assert.equal(member.self.codename, null);
  assert.equal((await getExchange(db, "alex"))?.recipient, null);
  await assert.rejects(complete(db), /release/i);

  const dueDrawMail = () => sqlite.prepare(`
    SELECT recipient FROM email_outbox
    WHERE kind = 'draw' AND status = 'pending' AND next_attempt_at <= unixepoch() ORDER BY recipient
  `).all().map(({ recipient }) => recipient);
  assert.deepEqual(dueDrawMail(), []);

  now = releaseAt;
  const released = await getExchange(db, "blake");
  const organizer = await getExchange(db, "alex");
  assert.ok(released?.recipient);
  assert.equal(released.recipient.name, organizer?.self.codename);
  assert.equal(organizer?.recipient?.name, released.self.codename);
  assert.deepEqual(dueDrawMail(), [user("alex").email, user("blake").email]);
  await mutateExchange(db, "alex", draw, origin);
  await complete(db);
  assert.equal((await getExchange(db, "blake"))?.recipient?.name, released.recipient.name);
});

test("invalid release dates leave the draw untouched and an immediate redraw replaces a scheduled draw", async () => {
  const fixture = await setup(2);
  const { db, sqlite } = fixture;
  sqlite.function("unixepoch", () => Date.parse("2026-12-20T23:00:00Z") / 1000);

  const first = await submission(db);
  for (const releaseTime of ["tomorrow", "2027-02-30T20:00", "2026-12-20T23:00"]) {
    first.set("releaseTime", releaseTime);
    await assert.rejects(mutateExchange(db, "alex", first, origin), /release/i);
  }
  assert.equal(fixture.count("draws"), 0);
  assert.equal(fixture.count("email_outbox", "kind = 'draw'"), 0);

  first.set("releaseTime", "2026-12-21T23:00");
  await mutateExchange(db, "alex", first, origin);
  assert.equal((await getExchange(db, "blake"))?.recipient, null);

  await mutateExchange(db, "alex", await submission(db, crypto.randomUUID(), "yes"), origin);
  assert.equal((await getExchange(db, "blake"))?.recipient?.name, "Alex");
  assert.equal(fixture.count("email_outbox", "kind = 'draw' AND status = 'cancelled'"), 2);
  assert.equal(fixture.count("email_outbox", "kind = 'draw' AND status = 'pending' AND next_attempt_at <= unixepoch()"), 2);
});

function drawReference(current: Awaited<ReturnType<typeof season>>) {
  return { seasonId: current.id, revision: current.revision, drawId: current.drawId ?? "" };
}

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

test("only the final draw of the latest completed season prevents repeats", async () => {
  const fixture = await setup(3);
  const { db } = fixture;
  let order = 0.999;
  vi.spyOn(Math, "random").mockImplementation(() => order);
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

test("group deletion cancels its pending mail and leaves other memberships intact", async () => {
  const fixture = await setup(2);
  const { db } = fixture;
  await mutateExchange(db, "alex", await submission(db), origin);
  await mutateExchange(db, "blake", form("invite", { email: "another@example.test" }), origin);
  const oldGroup = (await getExchange(db, "alex"))!.group.id;
  const second = await createGroup(db, user("blake"), { name: "Second", description: "", year: 2027, displayName: "Blake" });
  await mutateGroupExchange(db, "alex", oldGroup, form("delete-group", { groupId: oldGroup, confirm: "yes" }), origin);
  assert.equal(await getGroupExchange(db, "blake", oldGroup), null);
  assert.equal(fixture.count("assignments"), 0);
  assert.equal(fixture.count("email_outbox", "status = 'pending'"), 1);
  assert.equal(fixture.count("email_outbox", "status = 'cancelled'"), 5);
  assert.equal((await getGroupExchange(db, "blake", second))?.self.role, "organizer");
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
  t.onTestFinished(() => runtime.dispose());
  const db = await runtime.getD1Database("DB");
  for (const file of migrations) {
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
