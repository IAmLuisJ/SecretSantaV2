import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data, redirect } from "react-router";
import { workerContext } from "../context";
import type { Env } from "../env";
import { createGroup, ExchangeError, getExchange, getInvite, joinGroup } from "./exchange";
import { GiftError } from "./gifts";
import { authCookies, authPost, formValues, readForm, requestOrigin, verifiedUser } from "./http";

async function checkInviteLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`invite:${ip}`));
  const clientKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const result = await env.DB.prepare(`
    INSERT INTO invite_lookup_limits (client_key, expires_at, hits) VALUES (?, ?, 1)
    ON CONFLICT (client_key) DO UPDATE SET
      hits = CASE WHEN expires_at <= ? THEN 1 ELSE hits + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    RETURNING hits
  `).bind(clientKey, now + 300_000, now, now).first<{ hits: number }>();
  return (result?.hits ?? Infinity) <= 60;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = context.get(workerContext);
  requestOrigin(request, env);
  const url = new URL(request.url);
  const user = await verifiedUser(request, env);
  if (user && await getExchange(env.DB, user.id)) return redirect("/exchange");
  const code = url.searchParams.get("code")?.trim() ?? "";
  let invite = null;
  let error: string | undefined;
  if (code) {
    if (!/^[a-z0-9-]{4,40}$/i.test(code)) {
      error = "Check your group code and try again.";
    } else if (!await checkInviteLimit(request, env)) {
      error = "Too many code attempts. Try again in a few minutes.";
    } else {
      invite = await getInvite(env.DB, code);
      if (!invite) error = "We couldn’t find that group. Check the link or code and try again.";
    }
  }
  return { user, invite, error, defaultYear: new Date().getFullYear() };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { env, executionContext } = context.get(workerContext);
  const origin = requestOrigin(request, env);
  let form: FormData;
  try {
    form = await readForm(request, origin);
  } catch (error) {
    if (error instanceof GiftError) return data({ error: error.message, values: {} }, { status: 400 });
    throw error;
  }
  const values = formValues(form);
  const intent = values.intent;
  if (intent === "send-code" || intent === "verify-code") {
    const email = (values.email ?? "").trim().toLowerCase();
    const step = intent === "verify-code" ? "code" as const : "email" as const;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return data({ error: "Enter a valid email address.", step: "email" as const, values: { email } }, { status: 400 });
    }
    const code = String(form.get("code") ?? "");
    if (intent === "verify-code" && !/^\d{6}$/.test(code)) {
      return data({ error: "Enter the six-digit code.", step, values: { email } }, { status: 400 });
    }
    const response = await authPost(
      request, env, executionContext,
      intent === "send-code" ? "email-otp/send-verification-otp" : "sign-in/email-otp",
      intent === "send-code" ? { email, type: "sign-in" } : { email, otp: code },
    );
    if (!response.ok) {
      const error = response.status === 429 ? "Too many attempts. Try again in a few minutes."
        : intent === "verify-code" ? "That code is incorrect or expired. Try again or request a new one."
        : "We couldn’t send a code right now. Try again in a moment.";
      return data({ error, step, values: { email } }, { status: response.status === 429 ? 429 : 400 });
    }
    if (intent === "send-code") return { step: "code" as const, values: { email } };
    const inviteCode = new URL(request.url).searchParams.get("code");
    const destination = inviteCode ? `/join?code=${encodeURIComponent(inviteCode)}` : "/";
    return redirect(destination, { status: 303, headers: authCookies(response) });
  }
  const user = await verifiedUser(request, env);
  if (!user) return redirect("/", 303);
  if (intent === "sign-out") {
    const response = await authPost(request, env, executionContext, "sign-out");
    if (!response.ok) throw new Response(null, { status: 500 });
    return redirect("/", { status: 303, headers: authCookies(response) });
  }
  try {
    if (intent === "create-group") {
      await createGroup(env.DB, user, {
        name: values.name ?? "", description: values.description ?? "",
        year: Number(values.year ?? ""), displayName: values.displayName ?? "",
      }, origin);
    } else if (intent === "join-group") {
      if (!await checkInviteLimit(request, env)) throw new ExchangeError("Too many code attempts. Try again in a few minutes.");
      await joinGroup(env.DB, user, String(form.get("code") ?? ""), values.displayName ?? "", origin);
    } else {
      throw new Response(null, { status: 400 });
    }
    return redirect("/exchange", 303);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (!(error instanceof ExchangeError)) console.error("Group enrollment failed.");
    return data({
      values, error: error instanceof ExchangeError ? error.message : "We couldn’t save the group. Try again.",
    }, { status: error instanceof ExchangeError ? 400 : 500 });
  }
}
