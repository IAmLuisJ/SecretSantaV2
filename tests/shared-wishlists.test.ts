import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { test, type TestContext } from "vitest";
import type { Env } from "../app/env.ts";
import { getExchange } from "../app/server/exchange.ts";
import { cleanPhotos, getDashboard, GiftError, mutateGifts, readPhoto } from "../app/server/gifts.ts";
import { MembershipChanged } from "../app/server/actor.ts";

const origin = "https://santa.example.test";
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2xkAAAAASUVORK5CYII=", "base64"));

function form(intent: string, values: Record<string, string | File> = {}) {
  const result = new FormData();
  result.set("intent", intent);
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

async function exec(db: D1Database, sql: string) {
  await db.batch(sql.split(";").filter(statement => statement.trim()).map(statement => db.prepare(statement)));
}

async function setup(t: TestContext, legacy = false) {
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "shared-wishlists-test", compatibilityDate: "2026-11-07",
      env: { DB: { type: "d1", id: "wishlist-test-db" }, PHOTOS: { type: "r2", name: "wishlist-test-photos" } },
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {}" } } },
    } }],
  });
  t.onTestFinished(() => runtime.dispose());
  const DB = await runtime.getD1Database("DB");
  const PHOTOS = await runtime.getR2Bucket("PHOTOS");
  const migrations = new URL("../migrations/", import.meta.url);
  const files = (await readdir(migrations)).filter(file => file.endsWith(".sql")).sort();
  async function migrate(pending: boolean) {
    for (const file of files.filter(file => (file >= "0011") === pending)) {
      const sql = await readFile(new URL(file, migrations), "utf8");
      await DB.batch(sql.split(/;\n(?!END;)/).filter(statement => statement.trim()).map(statement => DB.prepare(statement)));
    }
  }
  await migrate(false);
  await exec(DB, `
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('alex', 'Alex', 'alex@example.test', 1, 0, 0),
      ('blake', 'Blake', 'blake@example.test', 1, 0, 0),
      ('casey', 'Casey', 'casey@example.test', 1, 0, 0),
      ('outsider', 'Outsider', 'outsider@example.test', 1, 0, 0);
    INSERT INTO groups VALUES ('family', 'Family', '', 'AAAAAAAAAAAAAAAA'),
      ('friends', 'Friends', '', 'BBBBBBBBBBBBBBBB'), ('elsewhere', 'Elsewhere', '', 'CCCCCCCCCCCCCCCC');
    INSERT INTO memberships VALUES
      ('alex-family', 'family', 'alex', 'alex@example.test', 'Alex', 'organizer'),
      ('blake-family', 'family', 'blake', 'blake@example.test', 'Blake', 'member'),
      ('alex-friends', 'friends', 'alex', 'alex@example.test', 'Alex', 'member'),
      ('casey-friends', 'friends', 'casey', 'casey@example.test', 'Casey', 'organizer'),
      ('outsider-elsewhere', 'elsewhere', 'outsider', 'outsider@example.test', 'Outsider', 'organizer');
    INSERT INTO seasons (id, group_id, year) VALUES ('s-family', 'family', 2026), ('s-friends', 'friends', 2026);
    INSERT INTO season_participants (group_id, season_id, membership_id) VALUES
      ('family', 's-family', 'alex-family'), ('family', 's-family', 'blake-family'),
      ('friends', 's-friends', 'alex-friends'), ('friends', 's-friends', 'casey-friends');
    INSERT INTO draws (id, group_id, season_id, revision, request_key) VALUES
      ('d-family', 'family', 's-family', 0, 'family-draw'), ('d-friends', 'friends', 's-friends', 0, 'friends-draw');
    INSERT INTO assignments (draw_id, season_id, giver_id, recipient_id) VALUES
      ('d-family', 's-family', 'alex-family', 'blake-family'), ('d-family', 's-family', 'blake-family', 'alex-family'),
      ('d-friends', 's-friends', 'alex-friends', 'casey-friends'), ('d-friends', 's-friends', 'casey-friends', 'alex-friends');
    UPDATE seasons SET active_draw_id = 'd-family' WHERE id = 's-family';
    UPDATE seasons SET active_draw_id = 'd-friends' WHERE id = 's-friends';
  `);
  if (!legacy) await migrate(true);
  const env = { DB, PHOTOS, BETTER_AUTH_SECRET: "synthetic-shared-wishlists-test-secret", APP_ORIGIN: origin } as Env;
  const submit = (user: string, group: string, intent: string, values: Record<string, string | File> = {}) =>
    mutateGifts(env, user, group, form(intent, values), `${user}-${group}`);
  async function dashboard(user = "alex", group = "family") {
    const exchange = await getExchange(DB, user, group);
    assert.ok(exchange);
    return getDashboard(DB, exchange, origin, user);
  }
  async function item(name: string) {
    const row = await DB.prepare("SELECT id FROM gift_items WHERE name = ?").bind(name).first<{ id: string }>();
    assert.ok(row);
    return row.id;
  }
  async function child() {
    const row = await DB.prepare("SELECT id FROM children WHERE name = 'Robin'").first<{ id: string }>();
    assert.ok(row);
    return row.id;
  }
  async function addPhoto(itemId: string) {
    const key = `gifts/${itemId}`;
    await PHOTOS.put(key, png);
    await DB.prepare("UPDATE gift_items SET photo_key = ? WHERE id = ?").bind(key, itemId).run();
  }
  return { DB, PHOTOS, env, submit, dashboard, item, child, migrate, addPhoto };
}

test("migration preserves legacy wishes, photos, purchases and exchange scopes in populated D1", async t => {
  const { DB, migrate, dashboard, submit } = await setup(t, true);
  await exec(DB, `
    INSERT INTO children VALUES ('robin', 'family', 'Robin', 6);
    INSERT INTO gift_items (id, group_id, owner_id, child_id, name, description, url, photo_key, purchased, created_at) VALUES
      ('book', 'family', 'alex-family', NULL, 'A book', 'Hardcover', 'https://example.test/book', 'gifts/book', 0, 123),
      ('train', 'family', NULL, 'robin', 'A train', '', '', 'gifts/train', 1, 456);
    INSERT INTO photo_cleanup VALUES ('existing-orphan', 987);
  `);
  await migrate(true);
  assert.equal(await DB.prepare("SELECT owner_id FROM gift_items WHERE id = 'book'").first("owner_id"), "alex");
  assert.deepEqual(await DB.prepare("SELECT id, group_id, name, description, url, photo_key, purchased, created_at FROM gift_items ORDER BY id").all().then(r => r.results), [
    { id: "book", group_id: "family", name: "A book", description: "Hardcover", url: "https://example.test/book", photo_key: "gifts/book", purchased: 0, created_at: 123 },
    { id: "train", group_id: "family", name: "A train", description: "", url: "", photo_key: "gifts/train", purchased: 1, created_at: 456 },
  ]);
  assert.equal((await dashboard()).items[0]?.scope, "exchange");
  assert.equal((await dashboard()).children[0]?.canClaim, true);
  assert.equal((await dashboard("alex", "friends")).items.length, 0);
  assert.deepEqual((await DB.prepare("SELECT * FROM photo_cleanup").all()).results, [{ photo_key: "existing-orphan", due_at: 987 }]);
  assert.deepEqual((await DB.prepare("PRAGMA foreign_key_check").all()).results, []);
  await submit("blake", "family", "claim-child", { childId: "robin" });
  assert.equal((await dashboard("blake")).children[0]?.canManage, true);
  await assert.rejects(submit("alex", "family", "claim-child", { childId: "robin" }), GiftError);
  await submit("alex", "family", "delete-item", { itemId: "book" });
  assert.ok(await DB.prepare("SELECT 1 FROM photo_cleanup WHERE photo_key = 'gifts/book'").first());
});

test("adult wishes are shared by default while exchange-specific wishes stay within one exchange", async t => {
  const { submit, dashboard } = await setup(t);
  await submit("alex", "family", "add-item", { name: "Shared book" });
  await submit("alex", "family", "add-item", { name: "Family scarf", scope: "exchange" });
  await submit("alex", "friends", "add-item", { name: "Friends mug", scope: "exchange" });
  assert.deepEqual((await dashboard("alex", "friends")).items.map(i => i.name), ["Shared book", "Friends mug"]);
  assert.deepEqual((await dashboard("blake", "family")).recipientItems.map(i => i.name), ["Shared book", "Family scarf"]);
  assert.deepEqual((await dashboard("casey", "friends")).recipientItems.map(i => i.name), ["Shared book", "Friends mug"]);
  assert.equal((await dashboard()).items[0]?.scope, "shared");
  assert.equal((await dashboard()).items[0]?.canManage, true);
});

test("a shared adult purchase reaches the other giver and is hidden from the owner's response", async t => {
  const { submit, dashboard, item, DB } = await setup(t);
  await submit("alex", "family", "add-item", { name: "Shared book" });
  const itemId = await item("Shared book");
  await submit("blake", "family", "set-purchased", { itemId, purchased: "yes" });
  assert.equal((await dashboard("casey", "friends")).recipientItems[0]?.purchased, true);
  assert.equal("purchased" in (await dashboard()).items[0], false);
  assert.equal("purchased" in (await dashboard("alex", "friends")).items[0], false);
  assert.equal(await DB.prepare("SELECT purchased FROM gift_items WHERE id = ?").bind(itemId).first("purchased"), 1);
  await assert.rejects(submit("alex", "family", "set-purchased", { itemId, purchased: "no" }), GiftError);
  await submit("casey", "friends", "set-purchased", { itemId, purchased: "no" });
  assert.equal((await dashboard("blake", "family")).recipientItems[0]?.purchased, false);
});

test("scope changes preserve item identity, photo and purchase status while enforcing the current exchange", async t => {
  const { submit, dashboard, item, env, DB, addPhoto } = await setup(t);
  await submit("alex", "family", "add-item", { name: "Photo wish" });
  const itemId = await item("Photo wish");
  await addPhoto(itemId);
  await submit("blake", "family", "set-purchased", { itemId, purchased: "yes" });
  await submit("alex", "friends", "set-item-scope", { itemId, scope: "exchange" });
  const wish = (await dashboard("casey", "friends")).recipientItems[0];
  assert.equal(wish?.id, itemId);
  assert.equal(wish?.purchased, true);
  assert.equal(wish?.photoUrl, `/photos/${itemId}`);
  assert.equal((await dashboard("blake", "family")).recipientItems.length, 0);
  assert.equal((await readPhoto(env, "blake", itemId)).status, 404);
  assert.equal((await readPhoto(env, "casey", itemId)).status, 200);
  await assert.rejects(submit("alex", "family", "set-item-scope", { itemId, scope: "shared" }), GiftError);
  await submit("alex", "friends", "set-item-scope", { itemId, scope: "shared" });
  assert.equal((await dashboard("blake", "family")).recipientItems[0]?.purchased, true);
  assert.equal((await DB.prepare("SELECT * FROM photo_cleanup").all()).results.length, 0);
});

test("only the latest released assigned giver may access or purchase an adult wish", async t => {
  const { submit, item, dashboard, env, DB, addPhoto } = await setup(t);
  await submit("alex", "family", "add-item", { name: "Private photo" });
  const itemId = await item("Private photo");
  await addPhoto(itemId);
  await DB.prepare("UPDATE draws SET release_at = unixepoch() + 3600 WHERE id = 'd-family'").run();
  assert.equal((await dashboard("blake", "family")).recipientItems.length, 0);
  assert.equal((await readPhoto(env, "blake", itemId)).status, 404);
  await assert.rejects(submit("blake", "family", "set-purchased", { itemId, purchased: "yes" }), GiftError);
  await assert.rejects(submit("outsider", "elsewhere", "set-purchased", { itemId, purchased: "yes" }), GiftError);
  await assert.rejects(submit("casey", "friends", "delete-item", { itemId }), GiftError);
  assert.equal((await readPhoto(env, "outsider", itemId)).status, 404);
  await assert.rejects(mutateGifts(env, "alex", "friends", form("add-item", { name: "Stale" }), "alex-family"), MembershipChanged);
  await DB.prepare("UPDATE draws SET release_at = NULL WHERE id = 'd-family'").run();
  await submit("blake", "family", "set-purchased", { itemId, purchased: "yes" });
  await DB.prepare("DELETE FROM assignments WHERE giver_id = 'blake-family'").run();
  assert.equal((await readPhoto(env, "blake", itemId)).status, 404);
  await assert.rejects(submit("blake", "family", "set-purchased", { itemId, purchased: "no" }), GiftError);
});

test("a managed Little One reuses one list across exchanges with purchases and private wishes kept in scope", async t => {
  const { submit, dashboard, child, item, env, addPhoto } = await setup(t);
  await submit("alex", "family", "add-child", { name: "Robin", age: "6" });
  const childId = await child();
  await submit("alex", "family", "add-item", { childId, name: "Shared train" });
  await addPhoto(await item("Shared train"));
  await submit("alex", "family", "add-item", { childId, name: "Family puzzle", scope: "exchange" });
  assert.equal((await dashboard("alex", "friends")).reusableChildren[0]?.id, childId);
  assert.equal((await dashboard("casey", "friends")).reusableChildren.length, 0);
  assert.equal((await readPhoto(env, "casey", await item("Shared train"))).status, 404);
  await submit("alex", "friends", "link-child", { childId });
  await submit("alex", "friends", "link-child", { childId });
  assert.equal((await dashboard("alex", "friends")).children.length, 1);
  assert.equal((await dashboard("alex", "friends")).reusableChildren.length, 0);
  assert.deepEqual((await dashboard("casey", "friends")).children[0]?.items.map(i => i.name), ["Shared train"]);
  await submit("blake", "family", "set-purchased", { itemId: await item("Shared train"), purchased: "yes" });
  assert.equal((await dashboard("casey", "friends")).children[0]?.items[0]?.purchased, true);
  assert.equal((await readPhoto(env, "casey", await item("Shared train"))).status, 200);
  await submit("casey", "friends", "set-purchased", { itemId: await item("Shared train"), purchased: "no" });
  assert.equal((await dashboard("blake", "family")).children[0]?.items[0]?.purchased, false);
});

test("child managers control sharing while group members can manage exchange-specific wishes", async t => {
  const { submit, dashboard, child, item, DB } = await setup(t);
  await submit("alex", "family", "add-child", { name: "Robin", age: "6" });
  const childId = await child();
  await submit("alex", "family", "add-item", { childId, name: "Shared train" });
  await assert.rejects(submit("blake", "family", "link-child", { childId }), GiftError);
  await assert.rejects(submit("outsider", "elsewhere", "claim-child", { childId }), GiftError);
  await assert.rejects(submit("blake", "family", "add-item", { childId, name: "Unauthorized shared", scope: "shared" }), GiftError);
  await submit("blake", "family", "add-item", { childId, name: "Local puzzle", scope: "exchange" });
  const sharedId = await item("Shared train");
  const localId = await item("Local puzzle");
  await assert.rejects(submit("blake", "family", "delete-item", { itemId: sharedId }), GiftError);
  await assert.rejects(submit("blake", "family", "set-item-scope", { itemId: localId, scope: "shared" }), GiftError);
  await submit("blake", "family", "delete-item", { itemId: localId });
  await assert.rejects(submit("casey", "friends", "add-item", { childId, name: "Not linked", scope: "exchange" }), GiftError);
  assert.equal((await dashboard("blake", "family")).children[0]?.items[0]?.canManage, false);
  assert.equal(await DB.prepare("SELECT count(*) AS count FROM gift_items").first("count"), 1);
});

test("shared adult and child wishes survive the originating group and photos are cleaned only on wish deletion", async t => {
  const { submit, dashboard, item, child, DB, PHOTOS, env, addPhoto } = await setup(t);
  await submit("alex", "family", "add-child", { name: "Robin", age: "6" });
  const childId = await child();
  await submit("alex", "friends", "link-child", { childId });
  for (const [name, scope, kid] of [["Shared book", "shared", ""], ["Family book", "exchange", ""], ["Shared train", "shared", childId], ["Family train", "exchange", childId]]) {
    await submit("alex", "family", "add-item", { name, scope, ...(kid ? { childId: kid } : {}) });
    await addPhoto(await item(name));
  }
  const sharedId = await item("Shared book");
  const key = await DB.prepare("SELECT photo_key FROM gift_items WHERE id = ?").bind(sharedId).first<string>("photo_key");
  assert.ok(key);
  await DB.prepare("DELETE FROM groups WHERE id = 'family'").run();
  assert.deepEqual((await dashboard("alex", "friends")).items.map(i => i.name), ["Shared book"]);
  assert.deepEqual((await dashboard("casey", "friends")).children[0]?.items.map(i => i.name), ["Shared train"]);
  assert.equal((await DB.prepare("SELECT * FROM photo_cleanup").all()).results.length, 2);
  assert.ok(await PHOTOS.get(key));
  await submit("alex", "friends", "delete-item", { itemId: sharedId });
  await cleanPhotos(env);
  assert.equal(await PHOTOS.get(key), null);
  assert.deepEqual((await DB.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("invalid sharing scopes and purchase values cannot mutate wishes", async t => {
  const { submit, item, DB } = await setup(t);
  await assert.rejects(submit("alex", "family", "add-item", { name: "Invalid", scope: "public" }), GiftError);
  await submit("alex", "family", "add-item", { name: "Shared book" });
  const itemId = await item("Shared book");
  await assert.rejects(submit("alex", "family", "set-item-scope", { itemId, scope: "public" }), GiftError);
  await assert.rejects(submit("blake", "family", "set-purchased", { itemId, purchased: "maybe" }), GiftError);
  assert.equal(await DB.prepare("SELECT count(*) AS count FROM gift_items").first("count"), 1);
});

test("changing a private wish requires an explicit sharing choice", async t => {
  const { submit, item, DB } = await setup(t);
  await submit("alex", "family", "add-item", { name: "Private book", scope: "exchange" });
  const itemId = await item("Private book");
  await assert.rejects(submit("alex", "family", "set-item-scope", { itemId }), GiftError);
  assert.equal(await DB.prepare("SELECT group_id FROM gift_items WHERE id = ?").bind(itemId).first("group_id"), "family");
});

test("an old account cannot load the surviving account's shared wishes after membership reassignment", async t => {
  const { DB, submit } = await setup(t);
  const staleExchange = await getExchange(DB, "alex", "family");
  assert.ok(staleExchange);
  await submit("outsider", "elsewhere", "add-item", { name: "Surviving account's wish" });
  await submit("outsider", "elsewhere", "add-child", { name: "Surviving account's child", age: "5" });
  await DB.prepare("UPDATE memberships SET user_id = 'outsider', email = 'outsider@example.test' WHERE user_id = 'alex'").run();
  await assert.rejects(getDashboard(DB, staleExchange, origin, "alex"), MembershipChanged);
});
