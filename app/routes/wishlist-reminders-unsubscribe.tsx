import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/wishlist-reminders-unsubscribe";
import { workerContext } from "../context";
import { requestOrigin } from "../server/http";
import { unsubscribeFromReminders, validateUnsubscribeLink } from "../server/wishlist-reminders";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  requestOrigin(request, env);
  // GET only previews the preference so email scanners cannot unsubscribe users.
  const state = await validateUnsubscribeLink(env, new URL(request.url));
  return { valid: state !== null, enabled: state?.enabled ?? false };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const url = new URL(request.url);
  // The signed link authorizes only opting out. Email clients can POST without
  // a session or Origin header using List-Unsubscribe-Post (RFC 8058).
  if (!await unsubscribeFromReminders(env, url)) {
    return new Response("This reminder link is invalid. Open the link in your latest reminder email.", { status: 400 });
  }
  if (request.headers.get("Origin") === origin) return redirect(url.pathname + url.search, 303);
  return new Response(null, { status: 200 });
}

export default function UnsubscribeWishlistReminders({ loaderData }: Route.ComponentProps) {
  const { valid, enabled } = loaderData;
  const navigation = useNavigation();
  return (
    <div className="entry">
      <div className="entry-hero"><div className="entry-hero-copy">
        <h1>{!valid ? "This reminder link is unavailable" : enabled ? "Turn off wishlist reminders?" : "Wishlist reminders are off"}</h1>
      </div></div>
      <section className="entry-paper">
        {!valid ? <p>Open the link in your latest reminder email, or sign in to manage your preferences.</p> : enabled ? (
          <>
            <p>You can stop wishlist reminders for all your exchanges. You don’t need to sign in.</p>
            <Form method="post" className="form-stack">
              <button className="button button-secondary" type="submit" disabled={navigation.state !== "idle"}>Turn off wishlist reminders</button>
            </Form>
          </>
        ) : <p role="status">You won’t receive any more wishlist reminders. You can turn them back on in your email preferences.</p>}
        <Link className="button button-quiet" to="/wishlist-reminders">Manage email preferences</Link>
      </section>
    </div>
  );
}
