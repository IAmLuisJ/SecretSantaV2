import { data, redirect } from "react-router";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/exchange";
import { workerContext } from "../context";
import { elfMailIntents } from "../elf-mail";
import { MembershipChanged } from "../server/actor";
import { ElfMailError, getElfMail, mutateElfMail } from "../server/elf-mail";
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
  const [dashboard, elfMail] = await Promise.all([
    getDashboard(env.DB, exchange, origin, mailAvailable(env)),
    getElfMail(env.DB, exchange),
  ]);
  return { ...dashboard, elfMail };
}

export function shouldRevalidate({ actionStatus, formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // A draw can open while the submitted form is being validated.
  if (actionStatus === 400) return true;
  const intent = formData?.get("intent");
  if (actionStatus !== 409) return defaultShouldRevalidate;
  return intent === "lock-santa-guess" || intent === "reveal-santa-guesses" || intent === "set-santa-guess"
    || Object.values(elfMailIntents).some(value => value === intent) || defaultShouldRevalidate;
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
    const message = await mutateElfMail(env.DB, user.id, params.groupId, form, memberId)
      ?? await mutateGifts(env, user.id, params.groupId, form, memberId)
      ?? await mutateExchange(env.DB, user.id, params.groupId, form, origin, memberId, mailAvailable(env));
    if (values.intent === "delete-group") return redirect("/", 303);
    return { values: { intent: values.intent, ...(values.childId ? { childId: values.childId } : {}) }, message };
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof MembershipChanged) return data({ values: {}, error: error.message }, { status: 409 });
    if (error instanceof ElfMailError) {
      return data({ values: error.status === 409 ? {} : values, error: error.message }, { status: error.status });
    }
    if (error instanceof GiftError || error instanceof ExchangeError) {
      const status = error instanceof ExchangeError ? error.status : 400;
      return data({ values: status === 409 ? {} : values, error: error.message }, { status });
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
