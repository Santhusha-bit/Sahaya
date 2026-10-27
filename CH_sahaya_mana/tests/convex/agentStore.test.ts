// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";

/**
 * The REAL Convex functions (convex/agentStore.ts) run in convex-test's local backend with synthetic identities.
 * This is not a deployment: it proves the functions' authorization and transaction logic, not Auth0/Convex setup.
 */
const modules = {
  ...import.meta.glob("../../convex/**/*.ts"),
  // convex-test locates the functions root via a "_generated" path; codegen isn't run (it could contact a deployment).
  "../../convex/_generated/locator.ts": async () => ({}),
};
const api = anyApi.agentStore;
const ISS = "https://tenant.example.auth0.com/";
const A = { issuer: ISS, subject: "auth0|alice" };
const B = { issuer: ISS, subject: "auth0|bob" };
const C = { issuer: ISS, subject: "auth0|carer" };
const id = (who: { issuer: string; subject: string }) => `${who.issuer}|${who.subject}`;

const msg = (userId: string, n: number, extra: object = {}) => ({ id: `msg_${n}`, agentId: "care", userId, role: "user", content: [{ type: "text", text: `hello ${n}` }], text: `hello ${n}`, channel: "text", at: n, ...extra });
const approval = (userId: string, over: object = {}) => ({
  id: "apr_1",
  agentId: "care",
  userId,
  toolName: "requestOrderApproval",
  input: { cartId: "c1" },
  inputHash: "h1",
  summary: "Place order",
  status: "pending",
  requestedBy: userId,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...over,
});

describe("Convex agent store: identity comes from ctx.auth only", () => {
  it("rejects unauthenticated calls", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.listMessages, { agentId: "care", userId: id(A) })).rejects.toThrow(/UNAUTHENTICATED/);
    await expect(t.mutation(api.appendMessage, { msg: msg(id(A), 1) })).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it("a user can't read or write another user's records by changing the userId or record id", async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity(A);
    const bob = t.withIdentity(B);
    await alice.mutation(api.appendMessage, { msg: msg(id(A), 1) });
    await alice.mutation(api.putMemory, { rec: { id: "m1", agentId: "care", userId: id(A), namespace: "care.memory", key: "f1", value: { kind: "allergy" }, text: "Memory", createdAt: 1, updatedAt: 1 } });
    await alice.mutation(api.saveApproval, { approval: approval(id(A)) });

    await expect(bob.query(api.listMessages, { agentId: "care", userId: id(A) })).rejects.toThrow(/FORBIDDEN/);
    await expect(bob.query(api.getMemory, { agentId: "care", userId: id(A), namespace: "care.memory", key: "f1" })).rejects.toThrow(/FORBIDDEN/);
    await expect(bob.mutation(api.deleteMemory, { agentId: "care", userId: id(A), namespace: "care.memory", key: "f1" })).rejects.toThrow(/FORBIDDEN/);
    await expect(bob.mutation(api.appendMessage, { msg: msg(id(A), 2) })).rejects.toThrow(/FORBIDDEN/);
    // Re-using Alice's record id from Bob's account can't overwrite it.
    await expect(bob.mutation(api.appendMessage, { msg: msg(id(B), 1) })).rejects.toThrow(/FORBIDDEN/);
    expect(await bob.query(api.getApproval, { id: "apr_1" })).toBeNull();
    expect(await bob.mutation(api.transitionApproval, { id: "apr_1", from: "pending", to: "approved" })).toBe(false);
    expect(await alice.query(api.listMessages, { agentId: "care", userId: id(A) })).toHaveLength(1);
    // Bob's own (and demo) data works.
    await bob.mutation(api.appendMessage, { msg: msg(`${id(B)}#demo`, 9, { id: "msg_bob_demo" }) });
    expect(await bob.query(api.listMessages, { agentId: "care", userId: `${id(B)}#demo` })).toHaveLength(1);
  });

  it("retries don't duplicate writes (upserts by record id)", async () => {
    const t = convexTest(schema, modules).withIdentity(A);
    await t.mutation(api.appendMessage, { msg: msg(id(A), 1) });
    await t.mutation(api.appendMessage, { msg: msg(id(A), 1) });
    const log = { id: "log_1", agentId: "care", userId: id(A), kind: "memory", level: "info", message: "Memory saved", at: 1 };
    await t.mutation(api.appendLog, { log });
    await t.mutation(api.appendLog, { log });
    expect(await t.query(api.listMessages, { agentId: "care", userId: id(A) })).toHaveLength(1);
    expect(await t.query(api.listLogs, { userId: id(A) })).toHaveLength(1);
  });
});

describe("Convex approvals: single-transaction decisions and consumption", () => {
  it("new approvals must be pending; status can't be granted via save", async () => {
    const t = convexTest(schema, modules).withIdentity(A);
    await expect(t.mutation(api.saveApproval, { approval: approval(id(A), { status: "approved" }) })).rejects.toThrow(/FORBIDDEN/);
    await t.mutation(api.saveApproval, { approval: approval(id(A)) });
    await expect(t.mutation(api.saveApproval, { approval: approval(id(A), { status: "approved" }) })).rejects.toThrow(/FORBIDDEN/);
  });

  it("decides once (approve/deny race), consumes once, and checks tool + input + expiry together", async () => {
    const t = convexTest(schema, modules).withIdentity(A);
    await t.mutation(api.saveApproval, { approval: approval(id(A)) });
    expect(await t.mutation(api.consumeApproval, { id: "apr_1" })).toBe(false); // not approved yet
    expect(await t.mutation(api.transitionApproval, { id: "apr_1", from: "pending", to: "approved" })).toBe(true);
    expect(await t.mutation(api.transitionApproval, { id: "apr_1", from: "pending", to: "denied" })).toBe(false);
    const row = await t.query(api.getApproval, { id: "apr_1" });
    expect(row).toMatchObject({ status: "approved", decidedBy: id(A) });
    expect(await t.mutation(api.consumeApproval, { id: "apr_1", expect: { userId: id(A), toolName: "placeOrder", inputHash: "h1" } })).toBe(false);
    expect(await t.mutation(api.consumeApproval, { id: "apr_1", expect: { userId: id(A), toolName: "requestOrderApproval", inputHash: "other" } })).toBe(false);
    expect(await t.mutation(api.consumeApproval, { id: "apr_1", expect: { userId: id(A), toolName: "requestOrderApproval", inputHash: "h1" } })).toBe(true);
    expect(await t.mutation(api.consumeApproval, { id: "apr_1", expect: { userId: id(A), toolName: "requestOrderApproval", inputHash: "h1" } })).toBe(false); // replay
  });

  it("expired approvals can't be approved or consumed", async () => {
    const t = convexTest(schema, modules).withIdentity(A);
    await t.mutation(api.saveApproval, { approval: approval(id(A), { id: "apr_old", expiresAt: Date.now() - 1 }) });
    expect(await t.mutation(api.transitionApproval, { id: "apr_old", from: "pending", to: "approved" })).toBe(false);
    expect((await t.query(api.getApproval, { id: "apr_old" })).status).toBe("expired");
  });
});

describe("Convex forgetting and caregiver grants", () => {
  it("redacts a forgotten value in text and tool payloads without breaking tool pairing", async () => {
    const t = convexTest(schema, modules).withIdentity(A);
    await t.mutation(api.appendMessage, {
      msg: { ...msg(id(A), 1), content: [{ type: "tool_use", id: "tu_1", name: "rememberAboutUser", input: { value: "Meadow Mill oat milk" } }], text: "" },
    });
    await t.mutation(api.appendMessage, { msg: { ...msg(id(A), 2), content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"value":"Meadow Mill oat milk"}' }], text: "I buy Meadow Mill oat milk" } });
    expect(await t.mutation(api.redactConversation, { agentId: "care", userId: id(A), terms: ["Meadow Mill oat milk"] })).toBe(2);
    const rows = await t.query(api.listMessages, { agentId: "care", userId: id(A) });
    expect(JSON.stringify(rows)).not.toContain("Meadow Mill");
    expect(rows[0].content[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "rememberAboutUser" });
    expect(rows[1].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("only the owner grants/revokes; caregivers can read their own grant but not the owner's data", async () => {
    const t = convexTest(schema, modules);
    const alice = t.withIdentity(A);
    const carer = t.withIdentity(C);
    const bob = t.withIdentity(B);
    const grant = { userId: id(A), caregiverId: id(C), agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"] };
    await expect(carer.mutation(api.setCaregiverPermission, { perm: grant })).rejects.toThrow(/FORBIDDEN/);
    await alice.mutation(api.setCaregiverPermission, { perm: grant });
    expect(await carer.query(api.getCaregiverPermission, { userId: id(A), caregiverId: id(C), agentId: "care" })).toMatchObject({ scopes: ["care:grocery"] });
    expect(await bob.query(api.getCaregiverPermission, { userId: id(A), caregiverId: id(C), agentId: "care" })).toBeNull();
    // Cross-account data access isn't supported in Convex mode yet: denied even with a grant.
    await expect(carer.query(api.listMemory, { agentId: "care", userId: id(A) })).rejects.toThrow(/FORBIDDEN/);
    await alice.mutation(api.setCaregiverPermission, { perm: { ...grant, canViewSummaries: false, scopes: [] } });
    expect(await carer.query(api.getCaregiverPermission, { userId: id(A), caregiverId: id(C), agentId: "care" })).toBeNull();
    await expect(alice.mutation(api.setCaregiverPermission, { perm: { ...grant, caregiverId: id(A) } })).rejects.toThrow(/VALIDATION/);
  });
});
