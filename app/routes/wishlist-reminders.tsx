import { data, Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/wishlist-reminders";
import { workerContext } from "../context";
import { readForm, requestOrigin, signedInUser } from "../server/http";
import { getReminderPreference, setReminderPreference } from "../server/wishlist-reminders";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  requestOrigin(request, env);
  const user = await signedInUser(request, env);
  if (!user) return redirect("/?next=%2Fwishlist-reminders");
  return { enabled: await getReminderPreference(env.DB, user.id) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const user = await signedInUser(request, env);
  if (!user) return redirect("/?next=%2Fwishlist-reminders", 303);
  const form = await readForm(request, origin);
  const enabled = form.get("enabled");
  if (enabled !== "0" && enabled !== "1") {
    return data({ error: "Choose whether to receive wishlist reminders." }, { status: 400 });
  }
  await setReminderPreference(env.DB, user.id, enabled === "1");
  return { message: enabled === "1" ? "Wishlist reminders are on." : "Wishlist reminders are off for all your exchanges." };
}

export default function WishlistReminders({ loaderData, actionData }: Route.ComponentProps) {
  const { enabled } = loaderData;
  const navigation = useNavigation();
  return (
    <div className="entry">
      <div className="entry-hero"><div className="entry-hero-copy"><h1>Wishlist reminders</h1></div></div>
      <section className="entry-paper" aria-label="Wishlist email preferences">
        {actionData && "message" in actionData && <p className="feedback feedback-success" role="status">{actionData.message}</p>}
        {actionData && "error" in actionData && <p className="feedback feedback-error" role="alert">{actionData.error}</p>}
        <p>Wishlist reminders are <strong>{enabled ? "on" : "off"}</strong> for all your exchanges.</p>
        <p>When you’ve been matched and your wish list is empty, we’ll email you one day after the draw and every three days after that. Reminders stop when you add a wish or the exchange ends.</p>
        <Form method="post" className="form-stack">
          <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
          <button className="button button-secondary" type="submit" disabled={navigation.state !== "idle"}>
            {enabled ? "Turn off wishlist reminders" : "Turn on wishlist reminders"}
          </button>
        </Form>
        <p className="section-note">This preference controls wishlist reminders. Sign-in codes and exchange announcements still arrive as usual.</p>
        <Link className="button button-quiet" to="/">Back to my exchanges</Link>
      </section>
    </div>
  );
}
