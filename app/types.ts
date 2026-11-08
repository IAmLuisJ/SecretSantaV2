export type User = { id: string; email: string };
export type Invite = { code: string; name: string; description: string };
export type Values = Record<string, string>;

export type Exchange = {
  group: Invite & { id: string };
  self: { id: string; name: string; role: "organizer" | "member" };
  members: { id: string; name: string; email: string; eligible: boolean }[];
  season: {
    id: string;
    year: number;
    completed: boolean;
    revision: number;
    drawId: string | null;
    drawRevision: number | null;
  } | null;
  exclusions: { firstId: string; secondId: string }[];
  recipient: { id: string; name: string } | null;
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
  requestId: string;
};
