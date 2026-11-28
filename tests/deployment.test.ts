import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "vitest";
import { verifyDeployment } from "../scripts/verify-deployment.ts";

const commit = "a".repeat(40);
const heartbeat = {
  status: "ok", commit,
  version: "00000000-0000-4000-8000-000000000001",
  timestamp: "2026-11-28T00:00:00.000Z",
};

async function serve(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.onTestFinished(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("release verification accepts the intended commit and platform metadata without cached responses", async t => {
  let calls = 0;
  const origin = await serve(t, (req, res) => {
    calls++;
    assert.equal(req.url, "/heartbeat");
    assert.equal(req.headers["cache-control"], "no-cache");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(heartbeat));
  });
  assert.deepEqual(await verifyDeployment(origin, commit, { attempts: 1 }), heartbeat);
  assert.equal(calls, 1);
});

test("release verification waits for the intended commit instead of accepting a healthy old release", async t => {
  let calls = 0;
  const origin = await serve(t, (_req, res) => {
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...heartbeat, commit: calls === 1 ? "b".repeat(40) : commit }));
  });
  const result = await verifyDeployment(origin, commit, { attempts: 3, intervalMs: 0 });
  assert.equal(result.commit, commit);
  assert.equal(calls, 2);
});

for (const [name, status, body, error] of [
  ["HTTP errors", 503, "unavailable", /HTTP 503/],
  ["invalid JSON", 200, "<html>sign in</html>", /JSON/],
  ["the wrong commit", 200, JSON.stringify({ ...heartbeat, commit: "b".repeat(40) }), /commit/],
  ["missing version metadata", 200, JSON.stringify({ ...heartbeat, version: null }), /version/],
  ["an invalid timestamp", 200, JSON.stringify({ ...heartbeat, timestamp: null }), /timestamp/],
  ["a parseable non-timestamp", 200, JSON.stringify({ ...heartbeat, timestamp: "1" }), /timestamp/],
  ["a year without a date-time", 200, JSON.stringify({ ...heartbeat, timestamp: "2026" }), /timestamp/],
  ["an impossible calendar date", 200, JSON.stringify({ ...heartbeat, timestamp: "2026-02-31T00:00:00Z" }), /timestamp/],
  ["a timestamp without a timezone", 200, JSON.stringify({ ...heartbeat, timestamp: "2026-11-28T00:00:00" }), /timestamp/],
  ["a non-ok heartbeat", 200, JSON.stringify({ ...heartbeat, status: "error" }), /status/],
] as const) {
  test(`release verification rejects ${name} after bounded retries`, async t => {
    let calls = 0;
    const origin = await serve(t, (_req, res) => {
      calls++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
    await assert.rejects(verifyDeployment(origin, commit, { attempts: 2, intervalMs: 0 }), error);
    assert.equal(calls, 2);
  });
}

test("release verification limits request duration", async t => {
  const hanging = await serve(t, () => {});
  await assert.rejects(verifyDeployment(hanging, commit, { attempts: 1, timeoutMs: 50 }), /failed/i);
});

test("release verification never follows a redirect to an otherwise valid heartbeat", async t => {
  let targetCalls = 0;
  const target = await serve(t, (_req, res) => {
    targetCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(heartbeat));
  });
  const redirect = await serve(t, (_req, res) => {
    res.writeHead(302, { Location: target + "/heartbeat" });
    res.end();
  });
  await assert.rejects(verifyDeployment(redirect, commit, { attempts: 1 }), /failed/i);
  assert.equal(targetCalls, 0);
});

for (const timestamp of ["2026-11-28T12:34:56.123456+05:30", "2026-11-28T00:00:00.123456Z"]) {
  test(`release verification accepts a full platform timestamp ${timestamp}`, async t => {
    const origin = await serve(t, (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ...heartbeat, timestamp }));
    });
    assert.equal((await verifyDeployment(origin, commit, { attempts: 1 })).timestamp, timestamp);
  });
}
