import type { Env } from "../env";
import type { User, Values } from "../types";
import { getAuth, handleAuth } from "./auth";
import { GiftError, MAX_PHOTO_BYTES } from "./gifts";

export function requestOrigin(request: Request, env: Env): string {
  const { origin } = new URL(request.url);
  if (env.APP_ORIGIN !== origin) {
    throw new Response("This address is unavailable.", { status: 421 });
  }
  return origin;
}

export async function verifiedUser(request: Request, env: Env): Promise<User | null> {
  if (!request.headers.get("Cookie")) return null;
  const session = await getAuth(env, requestOrigin(request, env)).api.getSession({ headers: request.headers });
  return session?.user.emailVerified ? { id: session.user.id, email: session.user.email } : null;
}

const maxFormBytes = MAX_PHOTO_BYTES + 64 * 1024;

export async function readForm(request: Request, origin: string): Promise<FormData> {
  if (request.headers.get("Origin") !== origin) throw new Response(null, { status: 403 });
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^(multipart\/form-data|application\/x-www-form-urlencoded)(;|$)/i.test(type)) {
    throw new Response(null, { status: 415 });
  }
  const reader = request.body?.getReader();
  if (!reader) throw new GiftError("The form was empty. Try again.");
  if (Number(request.headers.get("Content-Length")) > maxFormBytes) {
    await reader.cancel();
    throw new GiftError("Choose a photo that is 5 MB or smaller.");
  }
  let size = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxFormBytes) {
      await reader.cancel();
      throw new GiftError("Choose a photo that is 5 MB or smaller.");
    }
    chunks.push(new Uint8Array(value));
  }
  try {
    return await new Response(new Blob(chunks), { headers: { "Content-Type": type } }).formData();
  } catch {
    throw new GiftError("The form could not be read. Try again.");
  }
}

export function formValues(form: FormData): Values {
  const values: [string, string][] = [];
  for (const [key, value] of form) {
    if (typeof value === "string" && key !== "code" && value.length <= 2048) values.push([key, value]);
  }
  return Object.fromEntries(values);
}

export function authPost(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
  endpoint: string,
  body: Record<string, string> = {},
) {
  const origin = requestOrigin(request, env);
  const headers = new Headers({ "Content-Type": "application/json", Origin: origin });
  for (const header of ["Cookie", "CF-Connecting-IP"]) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }
  return handleAuth(new Request(new URL(`/api/auth/${endpoint}`, origin), {
    method: "POST", headers, body: JSON.stringify(body),
  }), env, executionContext);
}

export function authCookies(response: Response): Headers {
  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
  return headers;
}
