import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

/** The two synthetic accounts: A = the care recipient, CAREGIVER = their caregiver. */
export type Who = "A" | "CAREGIVER";
const VAR = { A: "E2E_USER_A", CAREGIVER: "E2E_CAREGIVER" } as const;

export function creds(who: Who) {
  const email = process.env[`${VAR[who]}_EMAIL`];
  const password = process.env[`${VAR[who]}_PASSWORD`];
  return email && password ? { email, password } : null;
}

/** Skip (never pass) when the live environment or a synthetic account isn't configured. */
export function requireLive(...who: Who[]) {
  test.skip(process.env.E2E_LIVE !== "1", "LIVE E2E not enabled: run `npm run e2e` with .env.e2e.local filled in (docs/e2e.md).");
  for (const w of who) test.skip(!creds(w), `Synthetic account ${VAR[w]}_EMAIL/_PASSWORD missing in .env.e2e.local.`);
}

/** Real Auth0 Universal Login (identifier-first or classic), accepting the first-login consent screen if shown. */
export async function login(page: Page, who: Who, opts: { expectProfile?: boolean } = {}) {
  const c = creds(who)!;
  await page.goto("/auth/login?returnTo=/profile");
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/login"));
  await page.locator("input#username, input[name=username], input[name=email]").first().fill(c.email);
  const password = page.locator("input#password, input[name=password]").first();
  if (!(await password.isVisible().catch(() => false))) {
    await page.locator("button[type=submit]").first().click();
    await password.waitFor();
  }
  await password.fill(c.password);
  await page.locator("button[type=submit][name=action], button[type=submit]").first().click();
  // Auth0 always asks localhost apps for consent on first login.
  await page.waitForURL((u) => u.pathname.startsWith("/profile") || u.pathname.includes("/consent"), { timeout: 60_000 });
  if (page.url().includes("/consent")) {
    await page.locator("button[value=accept]").first().click();
    await page.waitForURL(/\/profile/, { timeout: 60_000 });
  }
  if (opts.expectProfile !== false) await expect(page.getByText("Your Sahaya ID")).toBeVisible();
}

export async function mySahayaId(page: Page) {
  await page.goto("/profile");
  return (await page.locator("p.font-mono").first().textContent())!.trim();
}

export async function newSignedIn(context: BrowserContext, who: Who) {
  const page = await context.newPage();
  await login(page, who);
  return page;
}

const ORIGIN = () => process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** JSON API calls with the browser's cookies and a same-origin header (state changes require it). */
export function api(req: APIRequestContext) {
  return {
    get: (path: string) => req.get(path),
    post: (path: string, data: unknown) => req.post(path, { data, headers: { origin: ORIGIN() } }),
  };
}

export async function chat(page: Page, text: string) {
  const res = await api(page.request).post("/api/agents/care/message", { text });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { reply: string; status: string; toolCalls: Array<{ name: string; status: string }>; approvals: Array<{ id: string }> };
}

export async function memories(page: Page) {
  const res = await api(page.request).get("/api/care/dashboard");
  expect(res.status()).toBe(200);
  return ((await res.json()).memory ?? []) as Array<{ id: string; kind: string; value: string; status: string }>;
}
