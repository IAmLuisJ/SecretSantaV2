import { route } from "@react-router/dev/routes";
import type { RouteConfig } from "@react-router/dev/routes";

export default [
  route("/", "routes/entry.tsx"),
  route("join", "routes/join.tsx"),
  route("exchange", "routes/exchange.tsx"),
  route("photos/:id", "routes/photo.ts"),
  route("expired-invite", "routes/expired.tsx"),
] satisfies RouteConfig;
