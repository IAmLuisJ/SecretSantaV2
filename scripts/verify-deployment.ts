import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

type Heartbeat = { status: "ok"; commit: string; version: string; timestamp: string };
type VerificationOptions = { attempts?: number; intervalMs?: number; timeoutMs?: number };
const versionTimestamp = z.iso.datetime({ offset: true });

function validateHeartbeat(value: unknown, expectedCommit: string): Heartbeat {
  if (!value || typeof value !== "object" || !("status" in value) || value.status !== "ok") {
    throw new Error("Heartbeat status is not ok.");
  }
  if (!("commit" in value) || value.commit !== expectedCommit) {
    throw new Error(`Heartbeat commit does not match the expected release ${expectedCommit}.`);
  }
  if (!("version" in value) || typeof value.version !== "string"
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.version)) {
    throw new Error("Heartbeat has no valid Cloudflare version.");
  }
  if (!("timestamp" in value) || typeof value.timestamp !== "string" || !versionTimestamp.safeParse(value.timestamp).success) {
    throw new Error("Heartbeat has no valid version timestamp.");
  }
  return { status: "ok", commit: expectedCommit, version: value.version, timestamp: value.timestamp };
}

export async function verifyDeployment(
  origin: string,
  expectedCommit: string,
  { attempts = 12, intervalMs = 5_000, timeoutMs = 5_000 }: VerificationOptions = {},
): Promise<Heartbeat> {
  const url = new URL("/heartbeat", origin);
  let lastError = new Error("No heartbeat was received.");
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "error",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw new Error(`Heartbeat returned HTTP ${response.status}.`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("Heartbeat did not return valid JSON.");
      }
      return validateHeartbeat(body, expectedCommit);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Heartbeat request failed.");
    }
    if (attempt + 1 < attempts) await setTimeout(intervalMs);
  }
  throw new Error(`Deployment verification failed after ${attempts} attempts: ${lastError.message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [origin, commit] = process.argv.slice(2);
    if (!origin || !/^[a-f0-9]{40}$/i.test(commit ?? "")) {
      throw new Error("Usage: verify-deployment.ts <app-origin> <full-release-commit-sha>");
    }
    const heartbeat = await verifyDeployment(origin, commit);
    console.log(`Verified release ${heartbeat.commit} (Cloudflare version ${heartbeat.version}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Deployment verification failed.");
    process.exitCode = 1;
  }
}
