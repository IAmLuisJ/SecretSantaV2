import { createRequestHandler, RouterContextProvider } from "react-router";
import { workerContext } from "../app/context";
import type { Env } from "../app/env";
import { cleanPhotos } from "../app/server/gifts";
import { processOutbox } from "../app/server/mail";
import { queueWishlistReminders } from "../app/server/wishlist-reminders";

const handleRequest = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.PROD ? "production" : "development",
);

export default {
  async fetch(request, env, executionContext) {
    const context = new RouterContextProvider();
    context.set(workerContext, { env, executionContext });
    const response = await handleRequest(request, context);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "same-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },

  async scheduled(_event, env) {
    const outcomes = await Promise.allSettled([queueWishlistReminders(env), cleanPhotos(env)]);
    // Keep delivering other mail even if reminder discovery needs to retry.
    outcomes.push(...await Promise.allSettled([processOutbox(env)]));
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      console.error("Scheduled work will retry.");
    }
  },
} satisfies ExportedHandler<Env>;
