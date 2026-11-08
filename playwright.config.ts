import { defineConfig, devices } from "@playwright/test";

const origin = "http://127.0.0.1:5197";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  workers: 1,
  use: { baseURL: origin, actionTimeout: 8_000, navigationTimeout: 15_000 },
  webServer: {
    command: "node --experimental-strip-types scripts/e2e-server.ts",
    url: origin,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
  projects: [
    { name: "Mobile Chrome", use: { ...devices["Pixel 7"] } },
    { name: "Mobile WebKit", use: { ...devices["iPhone 13"] } },
  ],
});
