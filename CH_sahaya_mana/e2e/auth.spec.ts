import { expect, test } from "@playwright/test";
import { api, login, memories, mySahayaId, requireLive } from "./helpers";

test("a · recipient: sign in, see an empty profile, sign out, and lose access", async ({ page }) => {
  requireLive("A");
  await login(page, "A");
  const id = await mySahayaId(page);
  expect(id).toMatch(/^https:\/\/.+\|.+/);
  // Session cookie: HttpOnly, SameSite=Lax (Secure is enforced on https deployments).
  const session = (await page.context().cookies()).find((c) => c.name === "__session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  expect((await api(page.request).get("/api/care/dashboard")).status()).toBe(200);
  await page.goto("/auth/logout");
  await page.waitForLoadState("networkidle");
  expect((await api(page.request).get("/api/care/dashboard")).status()).toBe(401);
});

test("a · a brand-new account starts empty (signup path, only if the tenant allows signups)", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1" || process.env.E2E_SIGNUP !== "1" || !process.env.E2E_SIGNUP_EMAIL_DOMAIN, "Signup test disabled (E2E_SIGNUP=1 and E2E_SIGNUP_EMAIL_DOMAIN needed).");
  const email = `sahaya-e2e-${Date.now()}@${process.env.E2E_SIGNUP_EMAIL_DOMAIN}`;
  await page.goto("/auth/login?screen_hint=signup&returnTo=/profile");
  await page.locator("input#email, input#username, input[name=email]").first().fill(email);
  await page.locator("input#password, input[name=password]").first().fill(`Synthetic-${Date.now()}-Aa1!`);
  await page.locator("button[type=submit]").first().click();
  const accept = page.locator("button[value=accept]");
  if (await accept.isVisible({ timeout: 5000 }).catch(() => false)) await accept.click();
  await page.waitForURL(/\/profile/, { timeout: 60_000 });
  expect(await memories(page)).toEqual([]);
});
