import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE end-to-end tests against real Auth0 + Convex (development deployment) with synthetic accounts.
 * Credentials live in .env.e2e.local (git-ignored; see docs/e2e.md). Without them every spec SKIPS with the reason —
 * a skip is never reported as a pass. The server is started by e2e/run-live.mjs (production build on localhost:3000).
 */
if (existsSync(".env.e2e.local")) process.loadEnvFile(".env.e2e.local");

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  // No traces, screenshots, videos or HTML report: they would capture the synthetic accounts' credentials.
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
