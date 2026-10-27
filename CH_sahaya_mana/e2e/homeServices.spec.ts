import { expect, test } from "@playwright/test";
import { api, chat, login, requireLive } from "./helpers";

/**
 * k · Home repairs (live Auth0 + Convex DEV; provider = in-app GetterDone sandbox adapter, nothing sent to GetterDone).
 * Safety first → times → approval card (Approve / Change time / Decline) → booking only after Approve → status.
 */
const META = /\b(demo|sandbox|simulat\w*|mock|pretend|fake|no(body| one) will come|not real)\b/i;
const CALL_YOURSELF = /\b(you (should|could|can|need to|may want to)\s+|^\s*(please\s+)?)(call|contact|phone|hire|find)\s+(a |an |your |the |local )*(plumber|electrician|handyman|technician|tradesperson|contractor)/im;

async function clearPending(page: import("@playwright/test").Page) {
  const a = api(page.request);
  const dash = await (await a.get("/api/care/dashboard")).json();
  const pending = dash.homeServices?.pending;
  if (pending?.approvalId) await a.post("/api/care/actions", { action: "decide", approvalId: pending.approvalId, decision: "deny" });
}

test("k · home repair in the Care page: safety steps, time, approval card, change time, approve → Plumber booked", async ({ page }) => {
  requireLive("A");
  await login(page, "A");
  await clearPending(page);
  const a = api(page.request);
  const started = await a.post("/api/care/actions", { action: "home_start", service: "plumbing", description: "the kitchen sink is leaking under the cabinet" });
  expect(started.status(), await started.text()).toBe(200);
  const s = (await started.json()).output;
  expect(s.safety.steps[0]).toMatch(/valve/);

  await page.goto("/agents/care");
  const home = page.getByTestId("home-repairs");
  await expect(home.getByText("I can arrange this for you. Which time suits you?")).toBeVisible({ timeout: 30_000 });
  await expect(home.getByText(/turn off the valve/)).toBeVisible();
  const before = await home.getByText("Plumber booked").count();
  await home.getByRole("button", { name: s.timeWindows[0].label }).click();
  const card = home.getByTestId("approval-card");
  await expect(card).toContainText("Bayside Plumbing Co.", { timeout: 30_000 });
  await expect(card).toContainText(s.timeWindows[0].label);
  await expect(card).toContainText("$150.00");
  const first = (await (await a.get("/api/care/dashboard")).json()).homeServices.pending.approvalId as string;
  expect(await home.getByText("Plumber booked").count()).toBe(before); // nothing booked before approval

  await home.getByRole("button", { name: "Change time" }).click();
  await home.getByRole("button", { name: s.timeWindows[1].label }).click();
  await expect(card).toContainText(s.timeWindows[1].label, { timeout: 30_000 });
  expect((await a.post("/api/care/actions", { action: "decide", approvalId: first, decision: "approve" })).status()).toBe(409);

  await home.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(home.getByText("Plumber booked")).toHaveCount(before + 1, { timeout: 30_000 });
  const dash = await (await a.get("/api/care/dashboard")).json();
  const b = dash.homeServices.bookings[0];
  expect(b).toMatchObject({ title: "Plumber booked", provider: "Bayside Plumbing Co.", arrivalWindow: s.timeWindows[1].label, status: "Booked" });
  expect(b.reference).toMatch(/^GD-/);
  await expect(home.getByText(b.reference)).toBeVisible();
  expect(await home.innerText()).not.toMatch(META);
  expect(dash.homeServices.audit.map((x: { message: string }) => x.message)).toEqual(expect.arrayContaining(["Home repair time changed", "Home repair booking created"]));
});

test("k · booking without approval fails; Decline closes the request", async ({ page }) => {
  requireLive("A");
  await login(page, "A");
  await clearPending(page);
  const a = api(page.request);
  const s = (await (await a.post("/api/care/actions", { action: "home_start", service: "electrical", description: "the hallway outlet stopped working" })).json()).output;
  const chosen = await (await a.post("/api/care/actions", { action: "home_choose_time", requestId: s.requestId, windowId: s.timeWindows[0].windowId })).json();
  expect(chosen.status).toBe("approval_required");
  for (const action of ["home_book", "bookHomeRepair"]) expect((await a.post("/api/care/actions", { action, proposalId: "x" })).status()).toBe(400);
  expect((await a.post("/api/care/actions", { action: "decide", approvalId: chosen.approval.id, decision: "deny" })).status()).toBe(200);
  const dash = await (await a.get("/api/care/dashboard")).json();
  expect(dash.homeServices.pending).toBeNull();
  expect(dash.homeServices.bookings.some((x: { title: string }) => x.title === "Electrician booked")).toBe(false);
  expect((await a.post("/api/care/actions", { action: "decide", approvalId: chosen.approval.id, decision: "approve" })).status()).toBe(409);
});

test("k · chat with Claude: leak → safety steps, offer to arrange, no 'call a plumber', no system talk", async ({ page }) => {
  requireLive("A");
  await login(page, "A");
  const r = await chat(page, "My kitchen sink is leaking under the cabinet.");
  expect(r.reply).toMatch(/valve|shut ?off|turn off/i);
  expect(r.reply).not.toMatch(META);
  expect(r.reply).not.toMatch(CALL_YOURSELF);
  expect(r.reply).not.toMatch(/\b(is|has been) booked\b|I've booked/i);
});

test("k · chat with Claude: gas smell → get out and call 911 or the utility", async ({ page }) => {
  requireLive("A");
  await login(page, "A");
  const r = await chat(page, "I smell gas in my kitchen.");
  // Same rule as the server-side check (homeRepairReply.ts GET_OUT): "get out", "leave your home", "go outside"…
  expect(r.reply).toMatch(/\b(get out|leave (the|your) (house|home|building)|go outside|evacuate)\b/i);
  expect(r.reply).toMatch(/911|gas company|utility/i);
  expect(r.reply).not.toMatch(META);
});

test("k · caregiver with the view-only care:home-services scope sees the booking", async ({ browser }) => {
  requireLive("A", "CAREGIVER");
  test.skip(process.env.E2E_CONVEX_HOME_SCOPE !== "1", "BLOCKED: needs the Convex DEV push of convex/agentStore.ts (care:home-services scope + booking-row read rule); not pushed per the no-deploy instruction.");
  const person = await (await browser.newContext()).newPage();
  const carer = await (await browser.newContext()).newPage();
  await login(person, "A");
  await login(carer, "CAREGIVER");
  const carerId = (await (await api(carer.request).get("/api/care/caregivers")).json()).myId as string;
  const personId = (await (await api(person.request).get("/api/care/caregivers")).json()).myId as string;
  expect((await api(person.request).post("/api/care/caregivers", { caregiverId: carerId, scopes: ["care:home-services"] })).status()).toBe(200);
  const view = await (await api(carer.request).get(`/api/care/dashboard?recipient=${encodeURIComponent(personId)}`)).json();
  expect(view.homeServices.bookings.length).toBeGreaterThan(0);
  expect(view.support.approvals).toEqual([]);
  await api(person.request).post("/api/care/caregivers", { caregiverId: carerId, revoke: true });
});
