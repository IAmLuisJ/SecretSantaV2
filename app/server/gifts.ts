import type { Env } from "../env.ts";
import type { Address, Child, DashboardData, Exchange, GiftItem } from "../types.ts";
import { MembershipChanged } from "./actor.ts";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export class GiftError extends Error {}

function field(form: FormData, key: string, max: number, required = false): string {
  const value = form.get(key);
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new GiftError("Fill in the required fields.");
  if (result.length > max) throw new GiftError(`Keep this field to ${max} characters or fewer.`);
  return result;
}

export function productUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  const found = text.match(/https?:\/\/[^\s<>"]+/i)?.[0];
  try {
    const url = new URL(found ?? `https://${text}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname.includes(".") ||
      url.username ||
      url.password ||
      (!found && /[\s:@\\]/.test(text.split("/")[0]))
    ) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new GiftError("Enter a valid product link.");
  }
}

function jpegHasFrame(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (frames.has(marker)) {
      return length >= 8 && view.getUint16(offset + 3) > 0 && view.getUint16(offset + 5) > 0;
    }
    offset += length;
  }
  return false;
}

export async function inspectPhoto(file: File): Promise<string> {
  if (!file.size || file.size > MAX_PHOTO_BYTES) {
    throw new GiftError("Choose a photo that is 5 MB or smaller.");
  }
  const [header, trailer] = await Promise.all([file.slice(0, 24).arrayBuffer(), file.slice(-12).arrayBuffer()]);
  const bytes = new Uint8Array(header);
  const tail = new Uint8Array(trailer);
  const startsWith = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const endsWith = (signature: number[]) => signature.every((byte, index) => tail[tail.length - signature.length + index] === byte);
  const view = new DataView(header);
  const gif = new TextDecoder().decode(bytes.slice(0, 6));
  let type = "";
  if (file.size >= 20 && startsWith([0xff, 0xd8, 0xff]) && endsWith([0xff, 0xd9])) {
    if (jpegHasFrame(new Uint8Array(await file.arrayBuffer()))) type = "image/jpeg";
  } else if (
    file.size >= 57 && startsWith([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]) &&
    view.getUint32(16) > 0 && view.getUint32(20) > 0 && endsWith([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])
  ) {
    type = "image/png";
  } else if (
    file.size >= 25 && (gif === "GIF87a" || gif === "GIF89a") &&
    view.getUint16(6, true) > 0 && view.getUint16(8, true) > 0 && endsWith([0x3b])
  ) {
    type = "image/gif";
  }
  if (!type || (file.type && file.type !== "application/octet-stream" && file.type !== type)) {
    throw new GiftError("Choose a JPEG, PNG, or GIF photo.");
  }
  return type;
}

const latestRecipient = `
  SELECT a.recipient_id
  FROM memberships viewer
  JOIN seasons s ON s.group_id = viewer.group_id
  JOIN assignments a ON a.draw_id = s.active_draw_id AND a.giver_id = viewer.id
  WHERE viewer.user_id = ?
    AND s.id = (SELECT id FROM seasons WHERE group_id = viewer.group_id ORDER BY year DESC LIMIT 1)
`;

const addressColumns = `
  first_name AS firstName, last_name AS lastName, line1, line2,
  city, region, postal_code AS postalCode
`;

type ItemRow = Omit<GiftItem, "photoUrl" | "purchased"> & {
  photo_key: string | null;
  purchased: number;
  child_id: string | null;
};

function giftItem(row: ItemRow): GiftItem {
  return {
    id: row.id, name: row.name, description: row.description, url: row.url,
    purchased: Boolean(row.purchased),
    photoUrl: row.photo_key ? `/photos/${row.id}` : null,
  };
}

export async function getDashboard(
  db: D1Database,
  userId: string,
  exchange: Exchange,
  origin: string,
): Promise<DashboardData> {
  const { group, self, recipient } = exchange;
  const [address, items, children, childItems, recipientAddress, recipientItems] = await db.batch([
    db.prepare(`SELECT ${addressColumns} FROM addresses WHERE member_id = ?`).bind(self.id),
    db.prepare("SELECT * FROM gift_items WHERE owner_id = ? ORDER BY created_at, id").bind(self.id),
    db.prepare("SELECT id, name, age FROM children WHERE group_id = ? ORDER BY name, id").bind(group.id),
    db.prepare("SELECT * FROM gift_items WHERE group_id = ? AND child_id IS NOT NULL ORDER BY created_at, id").bind(group.id),
    db.prepare(`SELECT ${addressColumns} FROM addresses WHERE member_id = ? AND member_id = (${latestRecipient})`).bind(recipient?.id ?? "", userId),
    db.prepare(`SELECT * FROM gift_items WHERE owner_id = ? AND owner_id = (${latestRecipient}) ORDER BY created_at, id`).bind(recipient?.id ?? "", userId),
  ]);
  const byChild = new Map<string, GiftItem[]>();
  for (const row of childItems.results as ItemRow[]) {
    const childId = row.child_id!;
    const list = byChild.get(childId) ?? [];
    list.push(giftItem(row));
    byChild.set(childId, list);
  }
  return {
    exchange,
    address: (address.results[0] as Address | undefined) ?? null,
    items: (items.results as ItemRow[]).map(giftItem),
    recipientAddress: (recipientAddress.results[0] as Address | undefined) ?? null,
    recipientItems: (recipientItems.results as ItemRow[]).map(giftItem),
    children: (children.results as Omit<Child, "items">[]).map((child) => ({
      ...child,
      items: byChild.get(child.id) ?? [],
    })),
    inviteUrl: new URL(`/join?code=${encodeURIComponent(group.code)}`, origin).href,
    requestId: crypto.randomUUID(),
  };
}

export async function mutateGifts(env: Env, userId: string, form: FormData, expectedMemberId: string): Promise<string | null> {
  const intent = form.get("intent");
  if (!["save-address", "add-child", "add-item", "delete-item", "set-purchased"].includes(String(intent))) {
    return null;
  }
  const db = env.DB;
  const self = await db.prepare("SELECT id, group_id FROM memberships WHERE user_id = ?")
    .bind(userId).first<{ id: string; group_id: string }>();
  if (!self || self.id !== expectedMemberId) throw new MembershipChanged();
  const { id, group_id: groupId } = self;
  switch (intent) {
    case "save-address": {
      const values = [
        field(form, "firstName", 80, true), field(form, "lastName", 80, true),
        field(form, "line1", 140, true), field(form, "line2", 140),
        field(form, "city", 100, true), field(form, "region", 100, true), field(form, "postalCode", 24, true),
      ];
      await db.prepare(`
        INSERT INTO addresses (member_id, first_name, last_name, line1, line2, city, region, postal_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (member_id) DO UPDATE SET
          first_name = excluded.first_name, last_name = excluded.last_name,
          line1 = excluded.line1, line2 = excluded.line2, city = excluded.city,
          region = excluded.region, postal_code = excluded.postal_code
      `).bind(id, ...values).run();
      return "Address saved.";
    }
    case "add-child": {
      const name = field(form, "name", 100, true);
      const age = field(form, "age", 3, true);
      if (!/^\d{1,3}$/.test(age) || Number(age) > 120) throw new GiftError("Enter an age from 0 to 120.");
      await db.prepare("INSERT INTO children (id, group_id, name, age) VALUES (?, ?, ?, ?)")
        .bind(crypto.randomUUID(), groupId, name, Number(age)).run();
      return "Little One added.";
    }
    case "add-item": {
      const name = field(form, "name", 140, true);
      const description = field(form, "description", 1000);
      const url = productUrl(field(form, "url", 2048));
      const childId = field(form, "childId", 80) || null;
      if (childId && !await db.prepare("SELECT 1 FROM children WHERE id = ? AND group_id = ?").bind(childId, groupId).first()) {
        throw new GiftError("That wish list is unavailable.");
      }
      const itemId = crypto.randomUUID();
      const photo = form.get("photo");
      let key: string | null = null;
      if (photo instanceof File && (photo.name || photo.size)) {
        const type = await inspectPhoto(photo);
        key = `gifts/${itemId}`;
        await db.prepare("INSERT INTO photo_cleanup (photo_key, due_at) VALUES (?, ?)")
          .bind(key, Date.now() + 30 * 60 * 1000).run();
        try {
          await env.PHOTOS.put(key, photo.stream(), { httpMetadata: { contentType: type } });
        } catch {
          throw new GiftError("The photo upload failed. Choose the photo and try again.");
        }
      }
      const insert = db.prepare(`
        INSERT INTO gift_items (id, group_id, owner_id, child_id, name, description, url, photo_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(itemId, groupId, childId ? null : id, childId, name, description, url, key, Date.now());
      if (key) {
        await db.batch([insert, db.prepare("DELETE FROM photo_cleanup WHERE photo_key = ?").bind(key)]);
      } else {
        await insert.run();
      }
      return "Wish added.";
    }
    case "delete-item":
    case "set-purchased": {
      const itemId = field(form, "itemId", 80, true);
      let result: D1Result;
      if (intent === "delete-item") {
        result = await db.prepare(`
          DELETE FROM gift_items WHERE id = ? AND group_id = ? AND (owner_id = ? OR child_id IS NOT NULL)
        `).bind(itemId, groupId, id).run();
      } else {
        const value = form.get("purchased");
        if (value !== "yes" && value !== "no") throw new GiftError("Choose a valid purchase status.");
        result = await db.prepare(`
          UPDATE gift_items SET purchased = ? WHERE id = ? AND group_id = ? AND child_id IS NOT NULL
        `).bind(value === "yes" ? 1 : 0, itemId, groupId).run();
      }
      if (!result.meta.changes) throw new GiftError("That wish is unavailable.");
      return intent === "delete-item" ? "Wish removed." : "Purchase status saved.";
    }
  }
  return null;
}

export async function readPhoto(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT i.photo_key FROM gift_items i
    JOIN memberships m ON m.group_id = i.group_id AND m.user_id = ?
    WHERE i.id = ? AND i.photo_key IS NOT NULL
      AND (i.child_id IS NOT NULL OR i.owner_id = m.id OR i.owner_id = (${latestRecipient}))
  `).bind(userId, id, userId).first<{ photo_key: string }>();
  const object = row ? await env.PHOTOS.get(row.photo_key) : null;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (!object) return new Response(null, { status: 404, headers });
  return new Response(object.body, {
    headers: { ...headers, "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream" },
  });
}

export async function cleanPhotos(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`
    SELECT photo_key FROM photo_cleanup WHERE due_at <= ? ORDER BY due_at LIMIT 10
  `).bind(Date.now()).all<{ photo_key: string }>();
  for (const { photo_key } of results) {
    try {
      await env.PHOTOS.delete(photo_key);
      await env.DB.prepare("DELETE FROM photo_cleanup WHERE photo_key = ?").bind(photo_key).run();
    } catch {
      console.error("Photo cleanup will retry.");
    }
  }
  await env.DB.prepare(`
    DELETE FROM invite_lookup_limits WHERE client_key IN (
      SELECT client_key FROM invite_lookup_limits WHERE expires_at <= ? ORDER BY expires_at LIMIT 50
    )
  `).bind(Date.now()).run();
}
