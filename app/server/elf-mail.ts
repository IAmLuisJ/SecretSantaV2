import { elfMailIntents, elfMailPrompts, maxElfMailLength } from "../elf-mail.ts";
import type { ElfMail, ElfMailMessage } from "../elf-mail.ts";
import type { Exchange } from "../types.ts";

export class ElfMailError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
  }
}

const publishedMatch = `
  FROM memberships viewer
  JOIN seasons s ON s.id = (
    SELECT id FROM seasons WHERE group_id = viewer.group_id ORDER BY year DESC LIMIT 1
  )
  JOIN released_draws d ON d.id = s.active_draw_id
  JOIN assignments a ON a.season_id = s.id AND a.draw_id = d.id
`;

export async function getElfMail(
  db: D1Database,
  { group, self, season, readAt }: Pick<Exchange, "group" | "self" | "season" | "readAt">,
): Promise<ElfMail> {
  const mail: ElfMail = { toMatch: null, fromSanta: null };
  if (!season?.drawId || (season.drawReleaseAt !== null && season.drawReleaseAt > readAt)) return mail;

  const { results } = await db.prepare(`
    SELECT a.giver_id = viewer.id AS outgoing, m.sender, m.body
    ${publishedMatch}
    LEFT JOIN elf_mail_messages m ON m.draw_id = a.draw_id AND m.giver_id = a.giver_id
    WHERE viewer.id = ? AND viewer.group_id = ? AND s.id = ? AND a.draw_id = ?
      AND (a.giver_id = viewer.id OR a.recipient_id = viewer.id)
    ORDER BY m.id
  `).bind(self.id, group.id, season.id, season.drawId).all<
    { outgoing: number } & (ElfMailMessage | { sender: null; body: null })
  >();
  for (const { outgoing, sender, body } of results) {
    const direction = outgoing ? "toMatch" : "fromSanta";
    const messages = mail[direction] ??= [];
    if (sender !== null) messages.push({ sender, body });
  }
  return mail;
}

function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function mutateElfMail(
  db: D1Database,
  userId: string,
  groupId: string,
  form: FormData,
  expectedMemberId: string,
): Promise<string | null> {
  const intent = form.get("intent");
  const { prompt, question, reply } = elfMailIntents;
  if (intent !== prompt && intent !== question && intent !== reply) return null;

  const sender = intent === reply ? "recipient" : "giver";
  const roleColumn = intent === reply ? "recipient_id" : "giver_id";
  const body = intent === prompt
    ? elfMailPrompts.find(({ id }) => id === form.get("prompt"))?.text ?? ""
    : field(form, "body").replace(/\r\n?/g, "\n");
  if (!body) throw new ElfMailError(intent === prompt ? "Choose a prompt." : "Write a message before sending.");
  if (body.length > maxElfMailLength) throw new ElfMailError(`Keep your message to ${maxElfMailLength} characters.`);
  if (body.includes("\0")) throw new ElfMailError("Remove unsupported characters from your message.");

  const requestId = field(form, "requestId");
  if (!requestId || requestId.length > 100) throw new ElfMailError("Refresh the exchange before sending Elf Mail.", 409);

  // Check the published draw in the write itself so a redraw cannot redirect a stale message.
  const result = await db.prepare(`
    INSERT INTO elf_mail_messages (draw_id, giver_id, sender, request_id, body)
    SELECT a.draw_id, a.giver_id, ?, ?, ?
    ${publishedMatch}
    WHERE viewer.user_id = ? AND viewer.group_id = ? AND viewer.id = ?
      AND s.id = ? AND a.draw_id = ? AND a.${roleColumn} = viewer.id
      AND (? = 'giver' OR EXISTS (
        SELECT 1 FROM elf_mail_messages m
        WHERE m.draw_id = a.draw_id AND m.giver_id = a.giver_id AND m.sender = 'giver'
      ))
    ON CONFLICT (draw_id, giver_id, sender, request_id)
    DO UPDATE SET body = excluded.body WHERE elf_mail_messages.body = excluded.body
  `).bind(
    sender, requestId, body, userId, groupId, expectedMemberId,
    field(form, "seasonId"), field(form, "drawId"), sender,
  ).run();
  if (!result.meta.changes) {
    throw new ElfMailError("This Elf Mail conversation is unavailable. Check the current exchange and try again.", 409);
  }
  return intent === reply ? "Elf Mail reply sent." : "Elf Mail question sent.";
}
