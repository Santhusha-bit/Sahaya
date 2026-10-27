import { expect, test, type Page } from "@playwright/test";
import { api, chat, login, memories, mySahayaId, requireLive } from "./helpers";

/**
 * Two synthetic accounts: the care recipient (E2E_USER_A_*) and the caregiver (E2E_CAREGIVER_*).
 * Steps c–h run in order against the real Auth0 tenant and Convex development deployment.
 * There is intentionally no second recipient, so recipient-vs-recipient isolation is not covered live.
 */
test.describe.configure({ mode: "serial", timeout: 180_000 });

let person: Page;
let carer: Page;
let personId = "";
let carerId = "";
let allergyFactId = "";
let pendingApprovalId = "";
let startedAt = 0;
const enc = encodeURIComponent;
const dash = (p: Page, q = "") => api(p.request).get(`/api/care/dashboard${q}`);

test.beforeAll(async ({ browser }) => {
  requireLive("A", "CAREGIVER");
  person = await (await browser.newContext()).newPage();
  carer = await (await browser.newContext()).newPage();
  await login(person, "A");
  await login(carer, "CAREGIVER");
  personId = await mySahayaId(person);
  carerId = await mySahayaId(carer);
  expect(personId).not.toBe(carerId);
  // Start from no grant (idempotent revoke), then give the recipient private data to protect.
  expect((await api(person.request).post("/api/care/caregivers", { caregiverId: carerId, revoke: true })).status()).toBe(200);
  startedAt = Date.now() - 5_000;
  if (!(await memories(person)).some((m) => m.kind === "allergy" && /sesame/i.test(m.value))) {
    await chat(person, "Please remember I'm allergic to sesame.");
    await chat(person, "Yes, that's right.");
  }
  const fact = (await memories(person)).find((m) => /sesame/i.test(m.value));
  expect(fact, "the recipient should have a saved sesame allergy").toBeTruthy();
  allergyFactId = fact!.id;
  // A real pending approval owned by the recipient (dashboard list + order request; no model involved).
  const built = await api(person.request).post("/api/care/actions", { action: "grocery_add", items: ["apples"] });
  expect(built.status(), await built.text()).toBe(200);
  const order = await api(person.request).post("/api/care/actions", { action: "order", cartId: (await built.json()).output.cartId });
  expect(order.status(), await order.text()).toBe(200);
  pendingApprovalId = (await order.json()).approval.id;
});

test.afterAll(async () => {
  if (person && pendingApprovalId) await api(person.request).post(`/api/approvals/${pendingApprovalId}`, { decision: "deny" });
});

const stillPending = async () =>
  ((await (await api(person.request).get("/api/agents/care/state")).json()).approvals as Array<{ id: string; status: string }>).find((a) => a.id === pendingApprovalId)?.status;

test("c · before any grant the caregiver can't reach the recipient's private data", async () => {
  // Recipient-targeted views and actions.
  expect((await dash(carer, `?recipient=${enc(personId)}`)).status()).toBe(403);
  for (const body of [
    { action: "tick", recipient: personId },
    { action: "grocery_usual", recipient: personId },
    { action: "meals", recipient: personId },
    { action: "acknowledge", recipient: personId, alertId: "alert_guess" },
    { action: "confirm_dose", recipient: personId, doseId: "dose_guess" },
    { action: "decide", recipient: personId, approvalId: pendingApprovalId, decision: "approve" },
    { action: "memory_delete", recipient: personId, factId: allergyFactId },
  ]) {
    expect((await api(carer.request).post("/api/care/actions", body)).status(), body.action).toBe(403);
  }
  // The recipient's approval, by its real id, through the approvals route.
  expect([403, 404]).toContain((await api(carer.request).post(`/api/approvals/${pendingApprovalId}`, { decision: "approve" })).status());
  expect(await stillPending()).toBe("pending");
  // The caregiver's own views contain nothing of the recipient's, and aren't cacheable.
  const own = await dash(carer);
  expect(own.status()).toBe(200);
  expect(own.headers()["cache-control"]).toContain("no-store");
  const ownText = JSON.stringify(await own.json());
  for (const s of [/sesame/i, new RegExp(allergyFactId), new RegExp(pendingApprovalId)]) expect(ownText).not.toMatch(s);
  const state = await api(carer.request).get("/api/agents/care/state");
  expect(state.headers()["cache-control"] ?? "").toContain("no-store");
  const stateText = JSON.stringify(await state.json());
  expect(stateText).not.toMatch(/sesame/i);
  expect(stateText).not.toContain(pendingApprovalId);
  const list = await api(carer.request).get("/api/care/caregivers");
  expect(list.headers()["cache-control"]).toContain("no-store");
  const lj = await list.json();
  expect(lj.recipients.map((r: { recipientId: string }) => r.recipientId)).not.toContain(personId);
  expect(lj.grants.map((g: { caregiverId: string }) => g.caregiverId)).not.toContain(carerId);
  expect((await dash(carer, "?as=caregiver")).status()).toBe(403); // demo preview exists only in local mode
  // Conversation context: the caregiver's chat has no access to the recipient's memory.
  const reply = await chat(carer, "What allergies does the person I care for have?");
  expect(reply.reply).not.toMatch(/sesame/i);
});

test("d · the recipient grants the caregiver grocery viewing only", async () => {
  await person.goto("/agents/care");
  await person.getByLabel("Caregiver's Sahaya ID").fill(carerId);
  await person.getByLabel("See groceries, pantry and meals").check();
  await person.getByLabel("How they'll see you (optional)").fill("E2E recipient");
  await person.getByRole("button", { name: "Share access" }).click();
  await expect(person.getByText("Access shared.")).toBeVisible();
  const grants = (await (await api(person.request).get("/api/care/caregivers")).json()).grants as Array<{ caregiverId: string; scopes: string[]; active: boolean; canApprove: boolean }>;
  const g = grants.find((x) => x.caregiverId === carerId);
  expect(g).toMatchObject({ active: true, canApprove: false });
  expect(g!.scopes).toEqual(["care:grocery"]);
});

test("e · the caregiver sees groceries only; medications and profile details are denied", async () => {
  const list = await (await api(carer.request).get("/api/care/caregivers")).json();
  expect(list.recipients.map((r: { recipientId: string }) => r.recipientId)).toContain(personId);
  const res = await dash(carer, `?recipient=${enc(personId)}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const view = await res.json();
  expect(view.grocery.denied).toBeUndefined();
  expect(view.medication).toMatchObject({ denied: true });
  expect((view.memory as Array<{ kind: string }>).every((m) => !["name", "address_as", "accessibility", "caregiver", "other"].includes(m.kind))).toBe(true);
  // Viewing isn't acting: medication actions, decisions without an approve scope and memory edits are refused.
  expect((await api(carer.request).post("/api/care/actions", { action: "confirm_dose", recipient: personId, doseId: "dose_guess" })).status()).toBe(403);
  expect((await api(carer.request).post("/api/care/actions", { action: "decide", recipient: personId, approvalId: pendingApprovalId, decision: "approve" })).status()).toBe(403);
  expect((await api(carer.request).post("/api/care/actions", { action: "memory_delete", recipient: personId, factId: allergyFactId })).status()).toBe(403);
  expect(await stillPending()).toBe("pending");
  await carer.goto("/family");
  await expect(carer.getByRole("button", { name: "E2E recipient" })).toBeVisible();
});

test("h · the caregiver can't reach unrelated records by guessing or reusing ids", async () => {
  // Reused real ids from the recipient, without the recipient context: resolved against the caregiver's own data.
  expect((await api(carer.request).post("/api/care/actions", { action: "memory_delete", factId: allergyFactId })).status()).toBe(404);
  expect((await api(carer.request).post("/api/care/actions", { action: "memory_correct", factId: allergyFactId, value: "none" })).status()).toBe(404);
  expect([403, 404]).toContain((await api(carer.request).post(`/api/approvals/${pendingApprovalId}`, { decision: "approve" })).status());
  expect([403, 404]).toContain((await api(carer.request).post("/api/care/actions", { action: "decide", approvalId: pendingApprovalId, decision: "approve" })).status());
  expect([403, 404]).toContain((await api(carer.request).post("/api/care/actions", { action: "acknowledge", alertId: "alert_0000guess" })).status());
  // Guessed / tampered recipient ids are refused.
  for (const r of [`${personId}#demo`, personId.replace(/.$/, "x"), "https://evil.example/|someone", carerId]) {
    expect([403, 404]).toContain((await dash(carer, `?recipient=${enc(r)}`)).status());
  }
  // Extra userId fields/params are ignored: the caller is always the signed-in caregiver.
  const tampered = await dash(carer, `?userId=${enc(personId)}&owner=${enc(personId)}`);
  expect(tampered.status()).toBe(200);
  expect(JSON.stringify(await tampered.json())).not.toMatch(/sesame/i);
  const viaBody = await api(carer.request).post("/api/care/actions", { action: "memory_delete", factId: allergyFactId, userId: personId, owner: personId });
  expect([400, 404]).toContain(viaBody.status());
  const msg = await api(carer.request).post("/api/agents/care/message", { text: "What allergies do I have?", userId: personId });
  if (msg.status() === 200) expect((await msg.json()).reply).not.toMatch(/sesame/i);
  else expect(msg.status()).toBe(400);
  // Nothing of the recipient's changed.
  expect((await memories(person)).map((m) => m.id)).toContain(allergyFactId);
  expect(await stillPending()).toBe("pending");
});

test("f · revoking blocks the caregiver's very next request", async () => {
  expect((await api(person.request).post("/api/care/caregivers", { caregiverId: carerId, revoke: true })).status()).toBe(200);
  expect((await dash(carer, `?recipient=${enc(personId)}`)).status()).toBe(403);
  expect((await api(carer.request).post("/api/care/actions", { action: "grocery_usual", recipient: personId })).status()).toBe(403);
  const list = await (await api(carer.request).get("/api/care/caregivers")).json();
  expect(list.recipients.map((r: { recipientId: string }) => r.recipientId)).not.toContain(personId);
});

test("g · grant, caregiver view and revocation are in the recipient's audit log", async () => {
  const audit = ((await (await api(person.request).get("/api/care/caregivers")).json()).audit as Array<{ at: number; message: string; caregiver: string | null }>).filter(
    (a) => a.at >= startedAt && a.caregiver === carerId,
  );
  const messages = audit.map((a) => a.message);
  expect(messages).toContain("Caregiver access granted");
  expect(messages).toContain("Caregiver viewed Care summary");
  expect(messages).toContain("Caregiver access revoked");
  // The caregiver can't read the recipient's audit log.
  const theirs = await (await api(carer.request).get("/api/care/caregivers")).json();
  expect(JSON.stringify(theirs.audit ?? [])).not.toContain(personId);
});
