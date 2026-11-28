import { route } from "@react-router/dev/routes";
import type { RouteConfig } from "@react-router/dev/routes";

export default [
  route("/", "routes/entry.tsx"),
  route("join", "routes/join.tsx"),
  route("account", "routes/account.tsx"),
  route("exchange", "routes/exchange-index.ts"),
  route("exchange/:groupId", "routes/exchange.tsx"),
  route("wishlist-reminders", "routes/wishlist-reminders.tsx"),
  route("wishlist-reminders/unsubscribe", "routes/wishlist-reminders-unsubscribe.tsx"),
  route("photos/:id", "routes/photo.ts"),
  route("expired-invite", "routes/expired.tsx"),
] satisfies RouteConfig;
