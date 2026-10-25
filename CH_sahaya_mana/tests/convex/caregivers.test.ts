// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";

/** REAL Convex functions in convex-test's local backend; synthetic identities. Not a deployment. */
const modules = { ...import.meta.glob("../../convex/**/*.ts"), "../../convex/_generated/locator.ts": async () => ({}) };
const api = anyApi.agentStore;
const ISS = "https://tenant.example.auth0.com/";
const who = (s: string) => ({ issuer: ISS, subject: `auth0|${s}` });
const id = (s: string) => `${ISS}|auth0|${s}`;
const ANA = id("ana");
const CARER = id("carer");

const mem = (ns: string, key: string, value: object) => ({ id: `m_${key}`, agentId: "care", userId: ANA, namespace: ns, key, value, text: "", createdAt: 1, updatedAt: 1 });
const approval = (over: object = {}) => ({
  id: "apr_g",
  agentId: "care",
  userId: ANA,
  toolName: "requestOrderApproval",
  input: { cartId: "c1" },
  inputHash: "h1",
  summary: "Place order",
  status: "pending",
  requestedBy: ANA,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...over,
});

async function setup(scopes: string[], extra: object = {}) {
  const t = convexTest(schema, modules);
  const ana = t.withIdentity(who("ana"));
  await ana.mutation(api.putMemory, { rec: mem("care.medications", "med1", { name: "Synthetic med" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.pantry", "p1", { name: "Rice" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.memory", "f_allergy", { kind: "allergy", value: "peanuts" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.memory", "f_name", { kind: "name", value: "Ana" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.memory", "f_rem", { kind: "reminder_preference", value: "morning" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.alerts", "a_med", { area: "medications", title: "Missed dose" }) });
  await ana.mutation(api.putMemory, { rec: mem("care.alerts", "a_groc", { area: "grocery", title: "Low milk" }) });
  await ana.mutation(api.appendMessage, { msg: { id: "msg1", agentId: "care", userId: ANA, role: "user", content: "private", text: "private", channel: "text", at: 1 } });
  await ana.mutation(api.saveApproval, { approval: approval() });
  await ana.mutation(api.saveApproval, { approval: approval({ id: "apr_help", toolName: "requestPhysicalAssistance" }) });
  await ana.mutation(api.saveApproval, { approval: approval({ id: "apr_med", toolName: "submitPharmacyRefill" }) });
  await ana.mutation(api.setCaregiverPermission, {
    perm: { userId: ANA, caregiverId: CARER, agentId: "care", canViewSummaries: true, canApprove: scopes.some((s) => s.endsWith(":approve")), scopes, ...extra },
  });
  return { t, ana, carer: t.withIdentity(who("carer")), stranger: t.withIdentity(who("stranger")) };
}

const list = (c: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>, namespace?: string) => c.query(api.listMemory, { agentId: "care", userId: ANA, ...(namespace ? { namespace } : {}) });

describe("caregiver access in the Convex functions", () => {
  it("grocery view scope: grocery rows only; medication rows, profile facts and conversations stay private", async () => {
    const { carer } = await setup(["care:grocery"]);
    expect(await list(carer, "care.pantry")).toHaveLength(1);
    await expect(list(carer, "care.medications")).resolves.toEqual([]);
    await expect(list(carer)).rejects.toThrow(/FORBIDDEN/);
    expect((await list(carer, "care.memory")).map((r: { key: string }) => r.key)).toEqual(["f_allergy"]);
    expect((await list(carer, "care.alerts")).map((r: { key: string }) => r.key)).toEqual(["a_groc"]);
    await expect(carer.query(api.listMessages, { agentId: "care", userId: ANA })).rejects.toThrow(/FORBIDDEN/);
    await expect(carer.query(api.listMessages, { agentId: "finance", userId: ANA })).rejects.toThrow(/FORBIDDEN/);
    expect(await carer.query(api.getMemory, { agentId: "care", userId: ANA, namespace: "care.memory", key: "f_name" })).toBeNull();
    // Approvals: sees grocery requests, not medication ones; view scope alone can't decide.
    const visible = await carer.query(api.listApprovals, { userId: ANA, agentId: "care" });
    expect(visible.map((a: { id: string }) => a.id).sort()).toEqual(["apr_g", "apr_help"]);
    expect(await carer.mutation(api.transitionApproval, { id: "apr_g", from: "pending", to: "approved" })).toBe(false);
    // No writes without an approve scope.
    await expect(carer.mutation(api.putMemory, { rec: mem("care.pantry", "p2", { name: "Fake" }) })).rejects.toThrow(/FORBIDDEN/);
  });

  it("approve scope: decides only that area, never person-only requests; decision is attributed to the caregiver", async () => {
    const { carer } = await setup(["care:grocery", "care:grocery:approve"]);
    expect(await carer.mutation(api.transitionApproval, { id: "apr_help", from: "pending", to: "approved" })).toBe(false);
    expect(await carer.mutation(api.transitionApproval, { id: "apr_med", from: "pending", to: "approved" })).toBe(false);
    expect(await carer.mutation(api.transitionApproval, { id: "apr_g", from: "pending", to: "approved" })).toBe(true);
    expect(await carer.query(api.getApproval, { id: "apr_g" })).toMatchObject({ status: "approved", decidedBy: CARER });
    expect(await carer.mutation(api.consumeApproval, { id: "apr_g", expect: { userId: ANA, toolName: "requestOrderApproval", inputHash: "h1" } })).toBe(true);
    // Carrying out the grocery action may write grocery rows, but never the person's memory or medications.
    await carer.mutation(api.putMemory, { rec: mem("care.orders", "o1", { status: "placed" }) });
    await expect(carer.mutation(api.putMemory, { rec: mem("care.memory", "f_new", { kind: "usual_item" }) })).rejects.toThrow(/FORBIDDEN/);
    await expect(carer.mutation(api.putMemory, { rec: mem("care.medications", "med2", {}) })).rejects.toThrow(/FORBIDDEN/);
  });

  it("revoked, expired and missing grants fail closed; strangers and free user ids get nothing", async () => {
    const { ana, carer, stranger, t } = await setup(["care:grocery"]);
    await expect(list(stranger, "care.pantry")).rejects.toThrow(/FORBIDDEN/);
    expect(await stranger.query(api.getApproval, { id: "apr_g" })).toBeNull();
    await expect(stranger.query(api.listGrantsForCaregiver, { caregiverId: CARER })).rejects.toThrow(/FORBIDDEN/);
    expect(await carer.query(api.listGrantsForCaregiver, { caregiverId: CARER })).toHaveLength(1);
    await ana.mutation(api.setCaregiverPermission, { perm: { userId: ANA, caregiverId: CARER, agentId: "care", canViewSummaries: false, canApprove: false, scopes: [] } });
    await expect(list(carer, "care.pantry")).rejects.toThrow(/FORBIDDEN/);
    expect(await carer.query(api.listGrantsForCaregiver, { caregiverId: CARER })).toEqual([]);
    // Owner still sees the revoked grant as history.
    expect((await ana.query(api.listGrantsForOwner, { userId: ANA }))[0]).toMatchObject({ revokedAt: expect.any(Number) });
    void t;
  });

  it("an expired grant gives no access; expiry must be in the future; only the person can grant", async () => {
    const t = convexTest(schema, modules);
    const ana = t.withIdentity(who("ana"));
    const carer = t.withIdentity(who("carer"));
    await expect(ana.mutation(api.setCaregiverPermission, { perm: { userId: ANA, caregiverId: CARER, agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], expiresAt: Date.now() - 1 } })).rejects.toThrow(/VALIDATION/);
    await expect(carer.mutation(api.setCaregiverPermission, { perm: { userId: ANA, caregiverId: CARER, agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"] } })).rejects.toThrow(/FORBIDDEN/);
    await ana.mutation(api.putMemory, { rec: mem("care.pantry", "p1", { name: "Rice" }) });
    await ana.mutation(api.setCaregiverPermission, { perm: { userId: ANA, caregiverId: CARER, agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], expiresAt: Date.now() + 600 } });
    expect(await list(carer, "care.pantry")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 700));
    await expect(list(carer, "care.pantry")).rejects.toThrow(/FORBIDDEN/);
    expect(await carer.query(api.listGrantsForCaregiver, { caregiverId: CARER })).toEqual([]);
  });

  it("caregivers can append to the person's Care audit log but never read logs or tasks", async () => {
    const { carer } = await setup(["care:grocery"]);
    await carer.mutation(api.appendLog, { log: { id: "log_cg", agentId: "care", userId: ANA, kind: "audit", level: "info", message: "Caregiver viewed Care summary", at: 1 } });
    await expect(carer.query(api.listLogs, { userId: ANA })).rejects.toThrow(/FORBIDDEN/);
    await expect(carer.query(api.listTasks, { userId: ANA })).rejects.toThrow(/FORBIDDEN/);
  });

  it("care:home-services (view-only): booking rows only; requests/proposals/approvals stay private; no writes or decisions", async () => {
    const { ana, carer } = await setup(["care:home-services"]);
    await ana.mutation(api.putMemory, { rec: mem("care.homeServices", "booking:b1", { kind: "booking", title: "Plumber booked", reference: "GD-1" }) });
    await ana.mutation(api.putMemory, { rec: mem("care.homeServices", "request:r1", { kind: "request", description: "private" }) });
    await ana.mutation(api.putMemory, { rec: mem("care.homeServices", "proposal:p1", { kind: "proposal", issue: "private" }) });
    await ana.mutation(api.saveApproval, { approval: approval({ id: "apr_home", toolName: "bookHomeRepair" }) });
    expect((await list(carer, "care.homeServices")).map((r: { key: string }) => r.key)).toEqual(["booking:b1"]);
    await expect(list(carer, "care.pantry")).resolves.toEqual([]);
    expect(await carer.query(api.getApproval, { id: "apr_home" })).toBeNull();
    await expect(carer.mutation(api.putMemory, { rec: mem("care.homeServices", "booking:b2", { kind: "booking" }) })).rejects.toThrow(/FORBIDDEN/);
    await expect(carer.mutation(api.transitionApproval, { id: "apr_home", from: "pending", to: { status: "approved" } })).rejects.toThrow();
  });

  it("approve scopes for medications/groceries don't reveal home repairs or let a caregiver decide them", async () => {
    const { ana, carer } = await setup(["care:medications", "care:medications:approve", "care:grocery", "care:grocery:approve"]);
    await ana.mutation(api.putMemory, { rec: mem("care.homeServices", "booking:b1", { kind: "booking" }) });
    await ana.mutation(api.saveApproval, { approval: approval({ id: "apr_home", toolName: "bookHomeRepair" }) });
    await expect(list(carer, "care.homeServices")).resolves.toEqual([]);
    expect(await carer.query(api.getApproval, { id: "apr_home" })).toBeNull();
    expect(await carer.mutation(api.consumeApproval, { id: "apr_home" })).toBe(false);
  });
});
