import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/agents/base/MemoryStore";

/**
 * REAL route handlers, real runtime/agents/permissions. Only the outside world is replaced:
 *  - next/headers cookies (no request scope in tests),
 *  - the Auth0 SDK's getSession (a synthetic verified session),
 *  - the Convex network client: a shared in-memory store stands in for the database here; the Convex
 *    functions' own authorization is tested for real in tests/convex.
 * Synthetic identities only.
 */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined) }) }));
const auth = { session: null as null | { user: { sub: string }; tokenSet: { idToken?: string } } };
vi.mock("@/lib/auth0", () => ({ getAuth0: () => (process.env.SAHAYA_AUTH === "auth0" ? { getSession: async () => auth.session } : null) }));
const db = { store: new MemoryStore() };
vi.mock("@/lib/storage/ConvexStore", () => ({
  ConvexStore: class {
    constructor() {
      return db.store;
    }
  },
}));

const ISS = "https://tenant.example.auth0.com/";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (sub: string, exp = Math.floor(Date.now() / 1000) + 3600) => `${b64({ alg: "RS256" })}.${b64({ iss: ISS, aud: "client123", sub, exp })}.sig`;
const signIn = (sub: string, exp?: number) => (auth.session = { user: { sub }, tokenSet: { idToken: idToken(sub, exp) } });
const uid = (sub: string) => `${ISS}|${sub}`;

const ORIGIN = "http://127.0.0.1:3000";
const req = (path: string, body?: object) =>
  new NextRequest(`${ORIGIN}${path}`, body ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: ORIGIN, host: "127.0.0.1:3000" } } : undefined);

let storePath = "";
const ENV_KEYS = ["NODE_ENV", "SAHAYA_AUTH", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "SAHAYA_STORAGE", "NEXT_PUBLIC_CONVEX_URL", "SAHAYA_LOCAL_MODE", "SAHAYA_STORE", "SAHAYA_STORE_PATH", "CARTESIA_API_KEY"];
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;

function setEnv(vars: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete env[k];
  env.SAHAYA_STORE_PATH = storePath;
  Object.assign(env, vars);
}
const AUTH_ON = { NODE_ENV: "development", SAHAYA_AUTH: "auth0", AUTH0_DOMAIN: "tenant.example.auth0.com", AUTH0_CLIENT_ID: "client123", AUTH0_CLIENT_SECRET: "s", AUTH0_SECRET: "t" };
const CONVEX_ON = { SAHAYA_STORAGE: "convex", NEXT_PUBLIC_CONVEX_URL: "https://happy-animal-123.convex.cloud" };

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = env[k];
  storePath = join(mkdtempSync(join(tmpdir(), "sahaya-routes-")), "store.json");
  jar.clear();
  auth.session = null;
  db.store = new MemoryStore();
  const g = globalThis as Record<string, unknown>;
  delete g.sahayaLocal;
  delete g.sahayaInitialized;
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const routes = async () => ({
  dashboard: (await import("@/app/api/care/dashboard/route")).GET,
  actions: (await import("@/app/api/care/actions/route")).POST,
  state: (await import("@/app/api/agents/[agent]/state/route")).GET,
  approve: (await import("@/app/api/approvals/[id]/route")).POST,
  caregivers: (await import("@/app/api/care/caregivers/route")).POST,
  token: (await import("@/app/api/voice/token/route")).POST,
});

describe("fail closed without a verified identity", () => {
  it("no sign-in configured and no explicit local mode → 401 everywhere, nothing written", async () => {
    setEnv({ NODE_ENV: "development" });
    const r = await routes();
    expect((await r.dashboard(req("/api/care/dashboard"))).status).toBe(401);
    expect((await r.actions(req("/api/care/actions", { action: "tick" }))).status).toBe(401);
    expect((await r.actions(req("/api/care/actions", { action: "demo", enabled: true }))).status).toBe(401);
    expect((await r.state(req("/api/agents/care/state"), { params: Promise.resolve({ agent: "care" }) } as never)).status).toBe(401);
    expect((await r.approve(req("/api/approvals/apr_x", { decision: "approve" }), { params: Promise.resolve({ id: "apr_x" }) } as never)).status).toBe(401);
    expect(existsSync(storePath)).toBe(false);
  });

  it("sign-in enabled: signed out or expired → 401; voice tokens aren't minted", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON, CARTESIA_API_KEY: "synthetic" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let r = await routes();
    expect((await r.dashboard(req("/api/care/dashboard"))).status).toBe(401);
    expect((await r.token(req("/api/voice/token", {}))).status).toBe(401);
    signIn("auth0|alice", Math.floor(Date.now() / 1000) - 10);
    r = await routes();
    const res = await r.dashboard(req("/api/care/dashboard"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/expired/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("signed in but no secure database → 503, and never the local file (also in production)", async () => {
    for (const NODE_ENV of ["development", "production"]) {
      setEnv({ ...AUTH_ON, NODE_ENV });
      signIn("auth0|alice");
      const r = await routes();
      const res = await r.dashboard(req("/api/care/dashboard"));
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("STORAGE_UNAVAILABLE");
      expect(existsSync(storePath)).toBe(false);
    }
  });

  it("explicit local mode is ignored in production", async () => {
    setEnv({ NODE_ENV: "production", SAHAYA_LOCAL_MODE: "nonsensitive" });
    const r = await routes();
    expect((await r.dashboard(req("/api/care/dashboard"))).status).toBe(401);
    expect(existsSync(storePath)).toBe(false);
  });
});

describe("authenticated isolation at the route level", () => {
  async function seedAliceFact() {
    const { createSahayaRuntime } = await import("@/agents");
    const { careServices } = await import("@/agents/care/careTools");
    const runtime = createSahayaRuntime({ store: db.store, llm: { available: false } as never, integrationMode: () => "sandbox" });
    const care = runtime.get("care");
    const svc = careServices({ store: (care as unknown as { store: never }).store, now: Date.now, integrationMode: () => "sandbox", emit: async () => ({}) as never, ctx: {} });
    const res = await svc.memory.remember(uid("auth0|alice"), { by: uid("auth0|alice"), role: "older_adult", via: "dashboard" }, { kind: "grocery_preference", value: "low sodium" });
    const approval = await care.requestApproval({ userId: uid("auth0|alice"), actor: { id: uid("auth0|alice"), role: "older_adult" } }, "requestPhysicalAssistance", { need: "grocery_pickup", summary: "Pick up groceries" });
    return { factId: res.factId, approvalId: approval.id };
  }

  it("Bob can't see, change or delete Alice's memory or approvals by tampering with ids", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const { factId, approvalId } = await seedAliceFact();
    signIn("auth0|bob");
    const r = await routes();
    const dash = await (await r.dashboard(req("/api/care/dashboard"))).json();
    expect(dash.memory).toEqual([]);
    expect((await r.actions(req("/api/care/actions", { action: "memory_delete", factId }))).status).toBe(404);
    expect((await r.actions(req("/api/care/actions", { action: "memory_correct", factId, value: "salty" }))).status).toBe(404);
    const ap = await r.approve(req(`/api/approvals/${approvalId}`, { decision: "approve" }), { params: Promise.resolve({ id: approvalId }) } as never);
    expect([403, 404]).toContain(ap.status);
    const state = await (await r.state(req("/api/agents/care/state"), { params: Promise.resolve({ agent: "care" }) } as never)).json();
    expect(state.approvals).toEqual([]);
    // Alice's data is intact and visible only to her.
    signIn("auth0|alice");
    const mine = await (await (await routes()).dashboard(req("/api/care/dashboard"))).json();
    expect(mine.memory.map((m: { id: string }) => m.id)).toEqual([factId]);
    expect(mine.storage).toMatch(/secure database/);
  });

  it("caregiver previews are unavailable to signed-in people; grants are owner-only by verified id and revocable", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    signIn("auth0|alice");
    const r = await routes();
    expect((await r.dashboard(req("/api/care/dashboard?as=caregiver"))).status).toBe(403);
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: "Ellen (daughter)", scopes: ["care:grocery"] }))).status).toBe(400);
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: `${uid("auth0|alice")}#demo`, scopes: ["care:grocery"] }))).status).toBe(400);
    const carer = uid("auth0|carer");
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: carer, scopes: ["care:grocery"] }))).status).toBe(200);
    expect(await db.store.getCaregiverPermission(uid("auth0|alice"), carer, "care")).toMatchObject({ scopes: ["care:grocery"], canApprove: false });
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: carer, revoke: true }))).status).toBe(200);
    expect(await db.store.getCaregiverPermission(uid("auth0|alice"), carer, "care")).toBeNull();
  });

  it("the demo profile is the person's own separate profile, never mixed with real data", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    signIn("auth0|alice");
    jar.set("sahaya_profile", "demo");
    let dash = await (await (await routes()).dashboard(req("/api/care/dashboard"))).json();
    expect(dash.profileMode).toBe("demo");
    expect(dash.memory.length).toBeGreaterThan(0); // fictional demo facts
    jar.delete("sahaya_profile");
    dash = await (await (await routes()).dashboard(req("/api/care/dashboard"))).json();
    expect(dash.profileMode).toBe("real");
    expect(dash.memory).toEqual([]);
    expect((await db.store.listMemory("care", `${uid("auth0|alice")}#demo`)).length).toBeGreaterThan(0);
  });
});

describe("caregiver access end to end through the routes", () => {
  const ALICE = "auth0|alice";
  const CARER = "auth0|carer";
  const get = async (path: string) => {
    const r = await routes();
    const res = path.startsWith("/api/care/caregivers") ? await (await import("@/app/api/care/caregivers/route")).GET() : await r.dashboard(req(path));
    return { status: res.status, body: await res.json() };
  };

  it("grant → caregiver picks only granting recipients → permitted sections only → audited → revoke → denied", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    signIn(ALICE);
    let r = await routes();
    expect((await r.dashboard(req("/api/care/dashboard"))).status).toBe(200);
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: uid(CARER), scopes: ["care:grocery:approve"] }))).status).toBe(400); // approve needs view
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: uid(CARER), scopes: ["care:grocery", "care:grocery:approve"], canApprove: true, recipientLabel: "Mum" }))).status).toBe(200);

    // A pending person-only request and a grocery request (synthetic).
    const now = Date.now();
    const base = { agentId: "care" as const, userId: uid(ALICE), input: { x: 1 }, inputHash: "h", requestedBy: uid(ALICE), createdAt: now, expiresAt: now + 60_000, status: "pending" as const };
    await db.store.saveApproval({ ...base, id: "apr_help", toolName: "requestPhysicalAssistance", summary: "Help request" });
    await db.store.saveApproval({ ...base, id: "apr_meal", toolName: "bookMealDelivery", summary: "Meal delivery" });

    signIn(CARER);
    const mine = await get("/api/care/caregivers");
    expect(mine.body.recipients).toEqual([expect.objectContaining({ recipientId: uid(ALICE), label: "Mum", scopes: ["care:grocery", "care:grocery:approve"] })]);
    const view = await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`);
    expect(view.status).toBe(200);
    expect(view.body.viewer.role).toBe("caregiver");
    expect(view.body.medication).toMatchObject({ denied: true });
    expect(view.body.grocery).not.toHaveProperty("denied");
    expect(view.body.routes).toEqual([]);
    // A free user id without a grant, or the caregiver's own id, is refused.
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid("auth0|bob"))}`)).status).toBe(403);
    r = await routes();
    const act = (body: object) => r.actions(req("/api/care/actions", { recipient: uid(ALICE), ...body }));
    expect((await act({ action: "confirm_dose", doseId: "d1" })).status).toBe(403); // person-only
    expect((await act({ action: "decide", approvalId: "apr_help", decision: "approve" })).status).toBe(403); // person-only request
    expect((await act({ action: "decide", approvalId: "apr_meal", decision: "deny" })).status).toBe(200);

    signIn(ALICE);
    const overview = await get("/api/care/caregivers");
    const messages = overview.body.audit.map((a: { message: string }) => a.message);
    expect(messages).toEqual(expect.arrayContaining(["Caregiver access granted", "Caregiver viewed Care summary", "Caregiver declined a request"]));
    const auditLogs = (await db.store.listLogs({ userId: uid(ALICE), agentId: "care", limit: 500 })).filter((l) => l.kind === "audit");
    expect(JSON.stringify(auditLogs)).not.toMatch(/Meal delivery|Help request/); // no payloads
    r = await routes();
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: uid(CARER), revoke: true }))).status).toBe(200);

    signIn(CARER);
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`)).status).toBe(403);
    expect((await get("/api/care/caregivers")).body.recipients).toEqual([]);
  });

  it("an expired grant is denied", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    await db.store.setCaregiverPermission({ userId: uid(ALICE), caregiverId: uid(CARER), agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], expiresAt: Date.now() + 1500 });
    signIn(CARER);
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1600));
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`)).status).toBe(403);
  });

  it("caregiver views are unavailable in local mode and in the demo profile", async () => {
    setEnv({ NODE_ENV: "development", SAHAYA_LOCAL_MODE: "nonsensitive", SAHAYA_STORE: "memory" });
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`)).status).toBe(403);
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    signIn(CARER);
    jar.set("sahaya_profile", "demo");
    expect((await get(`/api/care/dashboard?recipient=${encodeURIComponent(uid(ALICE))}`)).status).toBe(403);
  });
});

describe("explicit local test mode", () => {
  it("works only when explicitly enabled, is labelled, and keeps demo and test profiles separate", async () => {
    setEnv({ NODE_ENV: "development", SAHAYA_LOCAL_MODE: "nonsensitive", SAHAYA_STORE: "memory" });
    const r = await routes();
    const real = await (await r.dashboard(req("/api/care/dashboard"))).json();
    expect(real).toMatchObject({ profileMode: "real", identityKind: "local", memory: [] });
    expect(real.storage).toMatch(/Local test mode/);
    jar.set("sahaya_profile", "demo");
    const demo = await (await (await routes()).dashboard(req("/api/care/dashboard"))).json();
    expect(demo.profileMode).toBe("demo");
    expect(demo.memory.length).toBeGreaterThan(0);
    // The person can add items to their list from the dashboard (real tool path); the cart is theirs only.
    const add = await (await routes()).actions(req("/api/care/actions", { action: "grocery_add", items: ["bananas"] }));
    expect(add.status).toBe(200);
    expect((await add.json()).output.cartId).toEqual(expect.any(String));
    jar.set("sahaya_profile", "test-smoke-1");
    const test = await (await (await routes()).dashboard(req("/api/care/dashboard"))).json();
    expect(test).toMatchObject({ profileMode: "test", memory: [] });
  });
});

describe("cross-site protection in the proxy", () => {
  it("blocks a cross-origin POST to the API and allows same-origin", async () => {
    setEnv({ NODE_ENV: "development" });
    const { proxy } = await import("@/proxy");
    const evil = new NextRequest(`${ORIGIN}/api/care/actions`, { method: "POST", body: "{}", headers: { origin: "https://evil.example", host: "127.0.0.1:3000" } });
    expect((await proxy(evil)).status).toBe(403);
    expect((await proxy(req("/api/care/actions", {}))).status).toBe(200);
  });
});
