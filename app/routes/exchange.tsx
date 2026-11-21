import { data, redirect } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/exchange";
import { workerContext } from "../context";
import { MembershipChanged } from "../server/actor";
import { ExchangeError, getExchange, mutateExchange } from "../server/exchange";
import { GiftError, getDashboard, mutateGifts } from "../server/gifts";
import { authCookies, authPost, formValues, readForm, requestOrigin, signedInUser } from "../server/http";
import { mailAvailable } from "../server/mail";
import { Dashboard } from "../ui";
import { exchangePath } from "../types";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const user = await signedInUser(request, env);
  if (!user) return redirect(`/?next=${encodeURIComponent(exchangePath(params.groupId))}`);
  const exchange = await getExchange(env.DB, user.id, params.groupId);
  if (!exchange) throw new Response("Exchange unavailable.", { status: 404 });
  return getDashboard(env.DB, exchange, origin, mailAvailable(env));
}

export function shouldRevalidate({ actionStatus, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // A draw can open while the submitted form is being validated.
  return actionStatus === 400 || defaultShouldRevalidate;
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env, executionContext } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const user = await signedInUser(request, env);
  if (!user) return redirect("/", 303);
  let values: Record<string, string> = {};
  try {
    const form = await readForm(request, origin);
    values = formValues(form);
    if (values.intent === "sign-out") {
      const response = await authPost(request, env, executionContext, "sign-out");
      if (!response.ok) throw new Response(null, { status: 500 });
      return redirect("/", { status: 303, headers: authCookies(response) });
    }
    const memberId = values.actingMembershipId ?? "";
    const message = await mutateGifts(env, user.id, params.groupId, form, memberId)
      ?? await mutateExchange(env.DB, user.id, params.groupId, form, origin, memberId, mailAvailable(env));
    if (values.intent === "delete-group") return redirect("/", 303);
    return { values: { intent: values.intent, ...(values.childId ? { childId: values.childId } : {}) }, message };
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof MembershipChanged) return data({ values: {}, error: error.message }, { status: 409 });
    if (error instanceof GiftError || error instanceof ExchangeError) {
      return data({ values, error: error.message }, { status: 400 });
    }
    console.error("Exchange action failed.");
    return data({ values, error: "We couldn’t save your changes. Try again." }, { status: 500 });
  }
}

export default function ExchangePage({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <Dashboard
      key={loaderData.exchange.group.id}
      data={loaderData}
      values={actionData?.values ?? {}}
      message={actionData && "message" in actionData ? actionData.message : undefined}
      error={actionData && "error" in actionData ? actionData.error : undefined}
    />
  );
}
