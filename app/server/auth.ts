import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Env } from "../env.ts";
import { isLoopbackOrigin, sendDirect } from "./mail.ts";

const basePath = "/api/auth";
const sendPath = basePath + "/email-otp/send-verification-otp";
const verifyPath = basePath + "/sign-in/email-otp";
const signOutPath = basePath + "/sign-out";
const windowSeconds = 15 * 60;
const otpSeconds = 5 * 60;

function allowedOrigin(env: Env, origin: string): boolean {
  const local = isLoopbackOrigin(origin);
  if (!env.APP_ORIGIN) return env.LOCAL_MAIL === "log" && local;
  const url = URL.parse(origin);
  return origin === env.APP_ORIGIN && url?.origin === origin && (url.protocol === "https:" || local);
}

function digest(secret: string, purpose: string, input: string): string {
  return createHmac("sha256", secret).update(purpose).update("\0").update(input).digest("hex");
}

function createAuth(env: Env, origin: string, onDeliveryFailure?: () => void) {
  return betterAuth({
    appName: "Gift Exchange For Friends",
    baseURL: origin,
    basePath,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      // The integration suite validates the versioned schema without per-request D1 introspection.
      database: { validateSchema: false },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // The public OTP routes apply atomic per-IP and per-email limits in D1.
    rateLimit: { enabled: false },
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: otpSeconds,
      allowedAttempts: 3,
      disableSignUp: false,
      storeOTP: {
        hash: async (otp) => digest(env.BETTER_AUTH_SECRET, "email-otp", otp),
      },
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "sign-in") return;
        try {
          await sendDirect(env, {
            to: email,
            subject: "Your Gift Exchange sign-in code",
            text: `Your sign-in code is ${otp}. It expires in 5 minutes.\n\nIf you did not request a code, you can ignore this email.`,
          }, { origin, key: "otp/" + crypto.randomUUID() });
        } catch {
          onDeliveryFailure?.();
        }
      },
    })],
  });
}

export function getAuth(env: Env, origin: string, _executionContext?: ExecutionContext) {
  if (!allowedOrigin(env, origin)) throw new Error("Untrusted authentication origin");
  return createAuth(env, origin);
}

function clientNetwork(request: Request, origin: string): string {
  if (isLoopbackOrigin(origin)) return "loopback";
  const address = request.headers.get("cf-connecting-ip") ?? "";
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6 || address.includes("%")) return "unknown";

  // Mask IPv6 hosts in the same /64 so changing the host portion cannot reset the quota.
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return words.slice(0, 4).join(":");
}

async function useLimit(env: Env, scope: string, value: string, maximum: number, cooldown = 0): Promise<boolean> {
  const key = digest(env.BETTER_AUTH_SECRET, "auth-limit:" + scope, value);
  const result = await env.DB.prepare(`
    INSERT INTO auth_rate_limits (key, count, expires_at, next_allowed_at)
    VALUES (?, 1, unixepoch() + ?, unixepoch() + ?)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN expires_at <= unixepoch() THEN 1 ELSE count + 1 END,
      expires_at = CASE WHEN expires_at <= unixepoch() THEN excluded.expires_at ELSE expires_at END,
      next_allowed_at = excluded.next_allowed_at
    WHERE expires_at <= unixepoch() OR (count < ? AND next_allowed_at <= unixepoch())
  `).bind(key, windowSeconds, cooldown, maximum).run();
  return result.meta.changes === 1;
}

function reject(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return Response.json({ message }, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}

export async function handleAuth(request: Request, env: Env, _executionContext?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!allowedOrigin(env, url.origin) || request.headers.get("Origin") !== url.origin) {
    return reject(403, "Untrusted request origin.");
  }
  if (![sendPath, verifyPath, signOutPath].includes(url.pathname)) return reject(404, "Not found.");
  if (request.method !== "POST") return reject(405, "Method not allowed.", { Allow: "POST" });

  let body: Record<string, string> = {};
  if (url.pathname !== signOutPath) {
    if (!request.headers.get("Content-Type")?.match(/^application\/json(?:\s*;|$)/i)) {
      return reject(415, "Expected a JSON request.");
    }
    const incoming = await request.json().catch(() => null);
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return reject(400, "Invalid request.");
    }
    const { email: submittedEmail, otp, type } = incoming as { email?: unknown; otp?: unknown; type?: unknown };
    const email = typeof submittedEmail === "string" ? submittedEmail.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return reject(400, "Enter a valid email address.");
    }

    const sending = url.pathname === sendPath;
    if (sending) {
      if (type !== "sign-in") return reject(400, "Invalid code type.");
      body = { email, type };
    } else {
      if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) return reject(400, "Enter the six-digit code.");
      body = { email, otp };
    }

    const scope = sending ? "send" : "verify";
    const ipAllowed = await useLimit(env, scope + ":ip", clientNetwork(request, url.origin), sending ? 20 : 80);
    const emailAllowed = ipAllowed && await useLimit(env, scope + ":email", email, sending ? 4 : 12, sending ? 45 : 0);
    if (!emailAllowed) return reject(429, "Too many attempts. Wait and try again.", { "Retry-After": "45" });
  }

  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  const authRequest = new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
  let deliveryFailed = false;
  const auth = createAuth(env, url.origin, () => { deliveryFailed = true; });
  const result = await auth.handler(authRequest);
  if (deliveryFailed || result.status >= 500) return reject(503, "Sign-in is temporarily unavailable.");
  if (url.pathname === verifyPath && !result.ok) {
    return reject(400, "That code is invalid or expired. Request a new code.");
  }
  const response = new Response(result.body, result);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
