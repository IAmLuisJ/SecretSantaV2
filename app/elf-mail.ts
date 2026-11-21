export const elfMailPrompts = [
  { id: "snack", text: "What snack would you hide from the rest of the house?" },
  { id: "color", text: "What color would you pick?" },
  { id: "cozy", text: "What makes a winter evening feel extra cozy?" },
] as const;

export const elfMailIntents = {
  prompt: "elf-mail-prompt",
  question: "elf-mail-question",
  reply: "elf-mail-reply",
} as const;

export const maxElfMailLength = 500;

export type ElfMailMessage = { sender: "giver" | "recipient"; body: string };

export type ElfMail = {
  toMatch: ElfMailMessage[] | null;
  fromSanta: ElfMailMessage[] | null;
};
