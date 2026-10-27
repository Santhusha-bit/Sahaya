import { expect, test } from "@playwright/test";
import { api } from "./helpers";

/** No accounts needed, but needs the live-configured server (SAHAYA_AUTH=auth0, SAHAYA_STORAGE=convex). */
test.beforeEach(() => test.skip(process.env.E2E_LIVE !== "1", "LIVE E2E not enabled (docs/e2e.md)."));

const DATA_GETS = ["/api/care/dashboard", "/api/agents/care/state", "/api/care/caregivers"];
const DATA_POSTS: Array<[string, unknown]> = [
  ["/api/care/actions", { action: "tick" }],
  ["/api/agents/care/message", { text: "hello" }],
  ["/api/approvals/apr_synthetic", { decision: "approve" }],
  ["/api/care/caregivers", { caregiverId: "x|y", scopes: ["care:grocery"] }],
  ["/api/voice/token", {}],
];

test("b · signed out: every data route answers 401 and leaks nothing", async ({ request }) => {
  for (const path of DATA_GETS) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
    expect(await res.text()).not.toMatch(/stack|at \w+ \(|convex\.cloud/i);
  }
  for (const [path, body] of DATA_POSTS) expect((await api(request).post(path, body)).status(), path).toBe(401);
});

test("b · a forged or garbage session cookie is rejected", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  const url = new URL(baseURL!);
  await ctx.addCookies([{ name: "__session", value: "forged.garbage.value", domain: url.hostname, path: "/" }]);
  expect((await ctx.request.get("/api/care/dashboard")).status()).toBe(401);
  await ctx.close();
});

test("b · cross-site writes are blocked and security headers are present", async ({ request }) => {
  const res = await request.post("/api/care/actions", { data: { action: "tick" }, headers: { origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
  const home = await request.get("/");
  const h = home.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["permissions-policy"]).toContain("microphone=(self)");
  expect(h["x-powered-by"]).toBeUndefined();
});

test("b · an unknown user id in the caregiver view is refused while signed out", async ({ request }) => {
  expect((await request.get("/api/care/dashboard?recipient=https%3A%2F%2Fx%2F%7Cauth0%7Cvictim")).status()).toBe(401);
});
