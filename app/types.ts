export type User = { id: string; email: string };
export type Invite = { code: string; name: string; description: string };
export type Values = Record<string, string>;
export type EntryStep = "email" | "code" | "password" | "register" | "group";
export type ExchangeSummary = { id: string; name: string; role: "organizer" | "member" };

export function exchangePath(groupId: string) {
  return `/exchange/${encodeURIComponent(groupId)}`;
}

export type Exchange = {
  group: Invite & { id: string };
  self: { id: string; name: string; codename: string | null; role: "organizer" | "member" };
  members: { id: string; name: string; email: string; eligible: boolean }[];
  season: {
    id: string;
    year: number;
    completed: boolean;
    revision: number;
    drawId: string | null;
    drawRevision: number | null;
    drawReleaseAt: number | null;
    codenameMode: boolean;
  } | null;
  readAt: number;
  exclusions: { firstId: string; secondId: string }[];
  recipient: { name: string } | null;
  waitingCount: number;
  mailFailures: number;
};

export type Address = {
  firstName: string;
  lastName: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
};

export type GiftItem = {
  id: string;
  name: string;
  description: string;
  url: string;
  photoUrl: string | null;
  purchased: boolean;
};

export type Child = { id: string; name: string; age: number; items: GiftItem[] };

export type DashboardData = {
  exchange: Exchange;
  address: Address | null;
  items: GiftItem[];
  recipientAddress: Address | null;
  recipientItems: GiftItem[];
  children: Child[];
  inviteUrl: string;
  mailEnabled: boolean;
  requestId: string;
};
