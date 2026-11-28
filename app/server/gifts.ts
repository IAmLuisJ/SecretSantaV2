import type { Env } from "../env.ts";
import type { Address, Child, DashboardData, GiftItem } from "../types.ts";
import { MembershipChanged } from "./actor.ts";
import type { getExchange } from "./exchange.ts";

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

const latestRecipient = (viewerId: "?" | "m.id") => `
  SELECT a.recipient_id
  FROM memberships viewer
  JOIN seasons s ON s.group_id = viewer.group_id
  JOIN released_draws d ON d.id = s.active_draw_id
  JOIN assignments a ON a.draw_id = d.id AND a.giver_id = viewer.id
  WHERE viewer.id = ${viewerId}
    AND s.id = (SELECT id FROM seasons WHERE group_id = viewer.group_id ORDER BY year DESC LIMIT 1)
`;

const addressColumns = `
  first_name AS firstName, last_name AS lastName, line1, line2,
  city, region, postal_code AS postalCode
`;

type ItemRow = Pick<GiftItem, "id" | "name" | "description" | "url"> & {
  photo_key: string | null;
  purchased: number;
  child_id: string | null;
  group_id: string | null;
  manager_id?: string | null;
};

function giftItem(row: ItemRow, canManage = false, hidePurchase = false): GiftItem {
  return {
    id: row.id, name: row.name, description: row.description, url: row.url,
    ...(!hidePurchase ? { purchased: Boolean(row.purchased) } : {}),
    photoUrl: row.photo_key ? `/photos/${row.id}` : null,
    scope: row.group_id === null ? "shared" : "exchange",
    canManage,
  };
}

export async function getDashboard(
  db: D1Database,
  exchange: NonNullable<Awaited<ReturnType<typeof getExchange>>>,
  origin: string,
  userId: string,
  mailEnabled = true,
): Promise<DashboardData> {
  const { group, self, recipient, season } = exchange;
  const addressRecipient = season?.codenameMode ? "" : recipient?.id ?? "";
  const [viewer, address, items, children, childItems, recipientAddress, recipientItems, reusableChildren] = await db.batch([
    // Account merges preserve the membership ID but change its user. Validate
    // the authenticated account in the same snapshot as all dashboard reads.
    db.prepare("SELECT 1 FROM memberships WHERE id = ? AND group_id = ? AND user_id = ?").bind(self.id, group.id, userId),
    db.prepare(`SELECT ${addressColumns} FROM addresses WHERE member_id = ?`).bind(self.id),
    db.prepare(`SELECT * FROM gift_items WHERE owner_id = ? AND (group_id IS NULL OR group_id = ?)
      ORDER BY created_at, id`).bind(userId, group.id),
    db.prepare(`SELECT c.id, c.name, c.age, c.manager_id FROM children c
      JOIN child_exchanges ce ON ce.child_id = c.id WHERE ce.group_id = ? ORDER BY c.name, c.id`).bind(group.id),
    db.prepare(`SELECT i.*, c.manager_id FROM gift_items i
      JOIN child_exchanges ce ON ce.child_id = i.child_id AND ce.group_id = ?
      JOIN children c ON c.id = i.child_id
      WHERE i.group_id IS NULL OR i.group_id = ? ORDER BY i.created_at, i.id`).bind(group.id, group.id),
    db.prepare(`SELECT ${addressColumns} FROM addresses WHERE member_id = ? AND member_id = (${latestRecipient("?")})`).bind(addressRecipient, self.id),
    db.prepare(`SELECT * FROM gift_items WHERE owner_id = (
      SELECT user_id FROM memberships WHERE id = ? AND id = (${latestRecipient("?")})
    ) AND (group_id IS NULL OR group_id = ?) ORDER BY created_at, id`).bind(recipient?.id ?? "", self.id, group.id),
    db.prepare(`SELECT id, name, age FROM children WHERE manager_id = ? AND NOT EXISTS (
      SELECT 1 FROM child_exchanges WHERE child_id = children.id AND group_id = ?
    ) ORDER BY name, id`).bind(userId, group.id),
  ]);
  if (viewer.results.length === 0) throw new MembershipChanged();
  const byChild = new Map<string, GiftItem[]>();
  for (const row of childItems.results as ItemRow[]) {
    const childId = row.child_id!;
    const list = byChild.get(childId) ?? [];
    list.push(giftItem(row, row.group_id !== null || row.manager_id === userId));
    byChild.set(childId, list);
  }
  return {
    exchange: { ...exchange, recipient: recipient ? { name: recipient.name } : null },
    address: (address.results[0] as Address | undefined) ?? null,
    items: (items.results as ItemRow[]).map(row => giftItem(row, true, true)),
    recipientAddress: (recipientAddress.results[0] as Address | undefined) ?? null,
    recipientItems: (recipientItems.results as ItemRow[]).map(row => giftItem(row)),
    children: (children.results as { id: string; name: string; age: number; manager_id: string | null }[]).map((child): Child => ({
      id: child.id, name: child.name, age: child.age,
      canManage: child.manager_id === userId,
      canClaim: child.manager_id === null,
      items: byChild.get(child.id) ?? [],
    })),
    reusableChildren: reusableChildren.results as DashboardData["reusableChildren"],
    inviteUrl: new URL(`/join?code=${encodeURIComponent(group.code)}`, origin).href,
    mailEnabled,
    requestId: crypto.randomUUID(),
  };
}

function wishScope(form: FormData, defaultScope?: GiftItem["scope"]): GiftItem["scope"] {
  const scope = form.get("scope") ?? defaultScope;
  if (scope !== "shared" && scope !== "exchange") throw new GiftError("Choose where to show this wish.");
  return scope;
}

export async function mutateGifts(env: Env, userId: string, groupId: string, form: FormData, expectedMemberId: string): Promise<string | null> {
  const intent = form.get("intent");
  if (!["save-address", "add-child", "link-child", "claim-child", "add-item", "delete-item", "set-purchased", "set-item-scope"].includes(String(intent))) {
    return null;
  }
  const db = env.DB;
  const self = await db.prepare("SELECT id FROM memberships WHERE user_id = ? AND group_id = ?")
    .bind(userId, groupId).first<{ id: string }>();
  if (!self || self.id !== expectedMemberId) throw new MembershipChanged();
  const { id } = self;
  const actor = "EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND id = ?)";
  const actorValues = [userId, groupId, id];
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
      const childId = crypto.randomUUID();
      const [created] = await db.batch([
        db.prepare(`INSERT INTO children (id, manager_id, name, age) SELECT ?, ?, ?, ? WHERE ${actor}`)
          .bind(childId, userId, name, Number(age), ...actorValues),
        db.prepare(`INSERT INTO child_exchanges (group_id, child_id) SELECT ?, id FROM children WHERE id = ? AND ${actor}`)
          .bind(groupId, childId, ...actorValues),
      ]);
      if (!created.meta.changes) throw new MembershipChanged();
      return "Little One added.";
    }
    case "link-child": {
      const childId = field(form, "childId", 80, true);
      // Repeated submissions are harmless, but ownership is checked even when
      // the child is already linked to this exchange.
      const child = await db.prepare("SELECT 1 FROM children WHERE id = ? AND manager_id = ?").bind(childId, userId).first();
      if (!child) throw new GiftError("That Little One is unavailable to share.");
      await db.prepare(`INSERT INTO child_exchanges (group_id, child_id)
        SELECT ?, id FROM children WHERE id = ? AND manager_id = ? AND ${actor}
        ON CONFLICT (group_id, child_id) DO NOTHING`).bind(groupId, childId, userId, ...actorValues).run();
      return "Little One added to this exchange. Shared wishes and purchases stay in sync.";
    }
    case "claim-child": {
      const childId = field(form, "childId", 80, true);
      const claimed = await db.prepare(`UPDATE children SET manager_id = ? WHERE id = ? AND manager_id IS NULL
        AND EXISTS (SELECT 1 FROM child_exchanges WHERE child_id = children.id AND group_id = ?)
        AND ${actor}`).bind(userId, childId, groupId, ...actorValues).run();
      if (!claimed.meta.changes) throw new GiftError("That Little One is unavailable to manage. Refresh and try again.");
      return "You can now manage this Little One’s shared list and use it in your other exchanges.";
    }
    case "add-item": {
      const name = field(form, "name", 140, true);
      const description = field(form, "description", 1000);
      const url = productUrl(field(form, "url", 2048));
      const childId = field(form, "childId", 80) || null;
      const child = childId ? await db.prepare(`SELECT c.manager_id FROM children c JOIN child_exchanges ce ON ce.child_id = c.id
        WHERE c.id = ? AND ce.group_id = ?`).bind(childId, groupId).first<{ manager_id: string | null }>() : null;
      if (childId && !child) throw new GiftError("That wish list is unavailable.");
      const canShare = !childId || child?.manager_id === userId;
      const scope = wishScope(form, canShare ? "shared" : "exchange");
      if (scope === "shared" && !canShare) throw new GiftError("Only this Little One’s manager can share wishes across exchanges.");
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
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${actor}
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM children c JOIN child_exchanges ce ON ce.child_id = c.id
            WHERE c.id = ? AND ce.group_id = ? AND (? = 'exchange' OR c.manager_id = ?)
          ))
      `).bind(itemId, scope === "shared" ? null : groupId, childId ? null : userId, childId, name, description, url, key, Date.now(),
        ...actorValues, childId, childId, groupId, scope, userId);
      let saved: D1Result;
      if (key) {
        [saved] = await db.batch([insert, db.prepare(`DELETE FROM photo_cleanup WHERE photo_key = ?
          AND EXISTS (SELECT 1 FROM gift_items WHERE id = ? AND photo_key = ?)`).bind(key, itemId, key)]);
      } else {
        saved = await insert.run();
      }
      if (!saved.meta.changes) throw new GiftError("That wish list changed. Refresh and try again.");
      return "Wish added.";
    }
    case "delete-item":
    case "set-item-scope":
    case "set-purchased": {
      const itemId = field(form, "itemId", 80, true);
      let result: D1Result;
      if (intent === "delete-item") {
        result = await db.prepare(`
          DELETE FROM gift_items WHERE id = ? AND (group_id IS NULL OR group_id = ?) AND ${actor}
            AND (owner_id = ? OR EXISTS (
              SELECT 1 FROM children c JOIN child_exchanges ce ON ce.child_id = c.id
              WHERE c.id = gift_items.child_id AND ce.group_id = ? AND (gift_items.group_id IS NOT NULL OR c.manager_id = ?)
            ))
        `).bind(itemId, groupId, ...actorValues, userId, groupId, userId).run();
      } else if (intent === "set-item-scope") {
        const scope = wishScope(form);
        result = await db.prepare(`UPDATE gift_items SET group_id = ?
          WHERE id = ? AND (group_id IS NULL OR group_id = ?) AND ${actor}
            AND (owner_id = ? OR EXISTS (
              SELECT 1 FROM children c JOIN child_exchanges ce ON ce.child_id = c.id
              WHERE c.id = gift_items.child_id AND ce.group_id = ? AND c.manager_id = ?
            ))
        `).bind(scope === "shared" ? null : groupId, itemId, groupId, ...actorValues, userId, groupId, userId).run();
      } else {
        const value = form.get("purchased");
        if (value !== "yes" && value !== "no") throw new GiftError("Choose a valid purchase status.");
        result = await db.prepare(`
          UPDATE gift_items SET purchased = ? WHERE id = ? AND (group_id IS NULL OR group_id = ?) AND ${actor}
            AND (EXISTS (SELECT 1 FROM child_exchanges WHERE child_id = gift_items.child_id AND group_id = ?)
              OR (owner_id <> ? AND owner_id = (SELECT user_id FROM memberships WHERE id = (${latestRecipient("?")}))))
        `).bind(value === "yes" ? 1 : 0, itemId, groupId, ...actorValues, groupId, userId, id).run();
      }
      if (!result.meta.changes) throw new GiftError("That wish is unavailable.");
      return intent === "delete-item" ? "Wish removed." : intent === "set-item-scope" ? "Wish sharing updated." : "Purchase status saved.";
    }
  }
  return null;
}

export async function readPhoto(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare(`
    SELECT i.photo_key FROM gift_items i WHERE i.id = ? AND i.photo_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM memberships m WHERE m.user_id = ? AND (i.group_id IS NULL OR i.group_id = m.group_id)
        AND (i.owner_id = m.user_id
          OR EXISTS (SELECT 1 FROM child_exchanges ce WHERE ce.child_id = i.child_id AND ce.group_id = m.group_id)
          OR i.owner_id = (SELECT user_id FROM memberships WHERE id = (${latestRecipient("m.id")})))
    )
  `).bind(id, userId).first<{ photo_key: string }>();
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
