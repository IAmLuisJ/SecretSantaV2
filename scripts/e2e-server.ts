import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "secret-santa-e2e-"));
const env = {
  ...process.env,
  SANTA_LOCAL_STATE: directory,
  SANTA_LOCAL_PORT: "5197",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  FORCE_COLOR: "0",
};
const migration = spawnSync(process.execPath, [
  "node_modules/cf/bin/cf", "d1", "migrations", "apply",
  "00000000-0000-4000-8000-000000000001",
  "--local", "--persist-to", directory,
], { env, stdio: "inherit" });
if (migration.status !== 0) {
  rmSync(directory, { recursive: true, force: true });
  process.exit(1);
}

mkdirSync(".cloudflare", { recursive: true });
const output = createWriteStream(".cloudflare/e2e-mail.log", { mode: 0o600 });
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
