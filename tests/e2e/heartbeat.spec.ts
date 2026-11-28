import { expect, test } from "@playwright/test";

test("heartbeat exposes only uncached release metadata without signing in", async ({ request }) => {
  const response = await request.get("/heartbeat");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["cache-control"]).toContain("no-store");
  const heartbeat = await response.json();
  expect(Object.keys(heartbeat).sort()).toEqual(["commit", "status", "timestamp", "version"]);
  expect(heartbeat.status).toBe("ok");
  expect(heartbeat.commit).toBe("0123456789abcdef0123456789abcdef01234567");
  expect(heartbeat.version).toMatch(/^[a-f0-9-]{36}$/i);
  expect(Number.isFinite(Date.parse(heartbeat.timestamp))).toBe(true);
});

test("heartbeat supports an uncached HEAD check", async ({ request }) => {
  const response = await request.head("/heartbeat");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.body()).toHaveLength(0);
});
