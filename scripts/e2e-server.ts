import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const port = process.env.SANTA_LOCAL_PORT ?? "5197";
const directory = mkdtempSync(join(tmpdir(), "secret-santa-e2e-"));
const env = {
  ...process.env,
  SANTA_LOCAL_STATE: directory,
  SANTA_LOCAL_PORT: port,
  SANTA_BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  X_LOCAL_EXPLORER: "true",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  FORCE_COLOR: "0",
};

async function applyMigrations() {
  const runtime = new Miniflare({
    // The Vite plugin uses this directory for the persisted local bindings.
    resourcePersistencePath: join(directory, "v3"),
    workers: [{ config: {
      name: "e2e-migrations",
      compatibilityDate: "2026-11-01",
      env: { DB: { type: "d1", id: "00000000-0000-4000-8000-000000000001" } },
      manifest: {
        mainModule: "index.js",
        modules: { "index.js": { type: "esm", contents: "export default {}" } },
      },
    } }],
  });
  try {
    const db = await runtime.getD1Database("DB");
    const files = readdirSync("migrations").filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join("migrations", file), "utf8");
      const statements = sql.split(/;\n(?!END;)/).filter(statement => statement.trim());
      await db.batch(statements.map(statement => db.prepare(statement)));
    }
  } finally {
    await runtime.dispose();
  }
}

try {
  await applyMigrations();
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}

mkdirSync(".cloudflare", { recursive: true });
const output = createWriteStream(`.cloudflare/e2e-mail-${port}.log`, { mode: 0o600 });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "dev"], { env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.pipe(output, { end: false });
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.kill(signal));
}
server.once("close", (code) => {
  output.end();
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = code ?? 0;
});
