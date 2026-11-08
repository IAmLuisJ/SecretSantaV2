import { bindings, defineConfig, triggers } from "cf/config";

const localDatabase = "00000000-0000-4000-8000-000000000001";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Set ${key} before building for Cloudflare.`);
  return value;
}

export default defineConfig(({ mode }) => {
  const remote = mode === "production" || mode === "staging";
  const origin = remote ? required("SANTA_APP_ORIGIN") : `http://127.0.0.1:${process.env.SANTA_LOCAL_PORT ?? "5173"}`;
  if (remote && (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)) {
    throw new Error("SANTA_APP_ORIGIN must be an HTTPS origin without a trailing slash.");
  }
  return {
    worker: {
      name: remote ? `secret-santa-v2${mode === "staging" ? "-staging" : ""}` : "secret-santa-v2-local",
      entrypoint: "./workers/app.ts",
      compatibilityDate: "2026-11-01",
      compatibilityFlags: ["nodejs_compat"],
      domains: remote ? [new URL(origin).hostname] : undefined,
      env: {
        DB: bindings.d1({ id: remote ? required("SANTA_D1_ID") : localDatabase }),
        PHOTOS: bindings.r2({ name: remote ? required("SANTA_R2_BUCKET") : "secret-santa-v2-local" }),
        APP_ORIGIN: bindings.text(origin),
        BETTER_AUTH_SECRET: bindings.secret(),
        ...(remote ? {
          RESEND_API_KEY: bindings.secret(),
          MAIL_FROM: bindings.text(required("SANTA_MAIL_FROM")),
        } : {
          LOCAL_MAIL: bindings.text("log"),
        }),
      },
      triggers: [triggers.scheduled({ schedule: "*/2 * * * *" })],
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: true, headSamplingRate: 0.1 },
      },
    },
  };
});
