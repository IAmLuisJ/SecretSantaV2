import { data, redirect } from "react-router";
import type { Route } from "./+types/exchange";
import { workerContext } from "../context";
import { MembershipChanged } from "../server/actor";
import { ExchangeError, getExchange, mutateExchange } from "../server/exchange";
import { GiftError, getDashboard, mutateGifts } from "../server/gifts";
import { authCookies, authPost, formValues, readForm, requestOrigin, verifiedUser } from "../server/http";
import { Dashboard } from "../ui";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const user = await verifiedUser(request, env);
  if (!user) return redirect("/");
  const exchange = await getExchange(env.DB, user.id);
  if (!exchange) return redirect("/");
  return getDashboard(env.DB, user.id, exchange, origin);
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, executionContext } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  const user = await verifiedUser(request, env);
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
    const message = await mutateGifts(env, user.id, form, memberId) ?? await mutateExchange(env.DB, user.id, form, origin, memberId);
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
      data={loaderData}
      values={actionData?.values ?? {}}
      message={actionData && "message" in actionData ? actionData.message : undefined}
      error={actionData && "error" in actionData ? actionData.error : undefined}
    />
  );
}
