import { expect, test } from "@playwright/test";

/**
 * Run by e2e/run-live.mjs against deliberately broken servers:
 *  E2E_SCENARIO=db-outage     → NEXT_PUBLIC_CONVEX_URL points at a non-existent deployment
 *  E2E_SCENARIO=auth-outage   → AUTH0_DOMAIN is unreachable
 *  E2E_SCENARIO=no-storage    → production build with SAHAYA_STORAGE unset (must refuse, never use local files)
 */
const scenario = process.env.E2E_SCENARIO;

test("j · safe outage — database outage: signed-in pages show a safe unavailable state", async ({ page }) => {
  test.skip(scenario !== "db-outage", "scenario db-outage only");
  const { login, requireLive } = await import("./helpers");
  requireLive("A");
  await login(page, "A", { expectProfile: false });
  const res = await page.request.get("/api/care/dashboard");
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.code).toBe("STORAGE_UNAVAILABLE");
  expect(JSON.stringify(body)).not.toMatch(/convex\.cloud|stack/i);
});

test("j · safe outage — identity provider outage: sign-in shows a safe page and data stays locked", async ({ page }) => {
  test.skip(scenario !== "auth-outage", "scenario auth-outage only");
  const res = await page.goto("/auth/login");
  expect(res?.status()).toBe(503);
  await expect(page.getByText("Sign-in is temporarily unavailable")).toBeVisible();
  expect((await page.request.get("/api/care/dashboard")).status()).toBe(401);
});

test("j · safe outage — production without the database refuses to serve instead of using local files", async ({ page }) => {
  test.skip(scenario !== "no-storage", "scenario no-storage only");
  const res = await page.goto("/");
  expect(res?.status()).toBe(503);
  await expect(page.getByText("isn't configured safely")).toBeVisible();
});
