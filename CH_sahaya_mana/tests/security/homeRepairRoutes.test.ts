import { mkdtempSync } from "node:fs";
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
 * Synthetic identities only. GetterDone: no key is configured, so nothing can reach the network (see also
 * tests/care/homeServices.test.ts for the mocked-HTTP adapter tests).
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



const LEAK = { service: "plumbing", description: "the kitchen sink is leaking under the cabinet" };

async function aliceCard() {
  signIn("auth0|alice");
  const r = await routes();
  const started = await r.actions(req("/api/care/actions", { action: "home_start", ...LEAK }));
  expect(started.status).toBe(200);
  const s = (await started.json()).output as { requestId: string; timeWindows: Array<{ windowId: string; label: string }>; safety: { steps: string[] } };
  const chosen = await (await r.actions(req("/api/care/actions", { action: "home_choose_time", requestId: s.requestId, windowId: s.timeWindows[0].windowId }))).json();
  expect(chosen.status).toBe("approval_required");
  return { ...s, approvalId: chosen.approval.id as string, summary: chosen.approval.summary as string };
}

describe("home repairs through the real routes", () => {
  it("signed out: refused", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const r = await routes();
    expect((await r.actions(req("/api/care/actions", { action: "home_start", ...LEAK }))).status).toBe(401);
    expect((await r.actions(req("/api/care/actions", { action: "home_choose_time", requestId: "hsr_x", windowId: "win_2026-10-27_09" }))).status).toBe(401);
  });

  it("there is no direct booking route; booking happens only by approving the card", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const c = await aliceCard();
    let r = await routes();
    for (const action of ["home_book", "bookHomeRepair", "home_confirm"]) {
      expect((await r.actions(req("/api/care/actions", { action, proposalId: "x" }))).status).toBe(400);
    }
    let dash = await (await r.dashboard(req("/api/care/dashboard"))).json();
    expect(dash.homeServices.bookings).toEqual([]);
    expect(dash.homeServices.pending.approvalId).toBe(c.approvalId);
    r = await routes();
    const decided = await (await r.actions(req("/api/care/actions", { action: "decide", approvalId: c.approvalId, decision: "approve" }))).json();
    expect(decided.result.output).toMatchObject({ title: "Plumber booked", provider: "Bayside Plumbing Co.", status: "Booked" });
    r = await routes();
    expect((await r.actions(req("/api/care/actions", { action: "decide", approvalId: c.approvalId, decision: "approve" }))).status).toBe(409);
    dash = await (await r.dashboard(req("/api/care/dashboard"))).json();
    expect(dash.homeServices.bookings).toHaveLength(1);
    expect(JSON.stringify(dash.homeServices)).not.toMatch(/demo|sandbox|simulat/i);
  });

  it("Change time via the route issues a new card and voids the old approval; Decline closes it", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const c = await aliceCard();
    let r = await routes();
    const changed = await (await r.actions(req("/api/care/actions", { action: "home_choose_time", requestId: c.requestId, windowId: c.timeWindows[1].windowId }))).json();
    expect(changed.approval.id).not.toBe(c.approvalId);
    expect((await r.actions(req("/api/care/actions", { action: "decide", approvalId: c.approvalId, decision: "approve" }))).status).toBe(409);
    r = await routes();
    expect((await r.actions(req("/api/care/actions", { action: "decide", approvalId: changed.approval.id, decision: "deny" }))).status).toBe(200);
    const dash = await (await r.dashboard(req("/api/care/dashboard"))).json();
    expect(dash.homeServices.pending).toBeNull();
    expect(dash.homeServices.bookings).toEqual([]);
  });

  it("another person can't use Alice's ids", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const c = await aliceCard();
    signIn("auth0|bob");
    const r = await routes();
    expect((await r.actions(req("/api/care/actions", { action: "home_choose_time", requestId: c.requestId, windowId: c.timeWindows[1].windowId }))).status).toBe(404);
    expect([403, 404, 409]).toContain((await r.actions(req("/api/care/actions", { action: "decide", approvalId: c.approvalId, decision: "approve" }))).status);
    expect([403, 404]).toContain((await r.approve(req(`/api/approvals/${c.approvalId}`, { decision: "approve" }), { params: Promise.resolve({ id: c.approvalId }) } as never)).status);
    expect(JSON.stringify(await (await r.dashboard(req("/api/care/dashboard"))).json())).not.toMatch(/kitchen sink is leaking/i);
    expect((await db.store.getApproval(c.approvalId))?.status).toBe("pending");
  });

  it("caregivers: approve scopes see nothing; the view-only care:home-services scope sees the booking only after approval; neither can decide", async () => {
    setEnv({ ...AUTH_ON, ...CONVEX_ON });
    const c = await aliceCard();
    let r = await routes();
    const full = uid("auth0|full");
    const viewer = uid("auth0|viewer");
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: full, scopes: ["care:medications", "care:medications:approve", "care:grocery", "care:grocery:approve"], canApprove: true }))).status).toBe(200);
    expect((await r.caregivers(req("/api/care/caregivers", { caregiverId: viewer, scopes: ["care:home-services"] }))).status).toBe(200);
    const recipient = uid("auth0|alice");
    const asCaregiver = async (sub: string) => {
      signIn(sub);
      const rr = await routes();
      return { rr, view: await (await rr.dashboard(req(`/api/care/dashboard?recipient=${encodeURIComponent(recipient)}`))).json() };
    };
    let { rr, view } = await asCaregiver("auth0|full");
    expect(view.homeServices).toMatchObject({ denied: true });
    expect((await rr.actions(req("/api/care/actions", { recipient, action: "decide", approvalId: c.approvalId, decision: "approve" }))).status).toBe(403);
    ({ rr, view } = await asCaregiver("auth0|viewer"));
    expect(view.homeServices).toEqual({ bookings: [] });
    expect((await rr.actions(req("/api/care/actions", { recipient, action: "decide", approvalId: c.approvalId, decision: "deny" }))).status).toBe(403);
    expect((await rr.actions(req("/api/care/actions", { recipient, action: "home_choose_time", requestId: c.requestId, windowId: c.timeWindows[1].windowId }))).status).toBe(403);
    signIn("auth0|alice");
    r = await routes();
    await r.actions(req("/api/care/actions", { action: "decide", approvalId: c.approvalId, decision: "approve" }));
    ({ view } = await asCaregiver("auth0|viewer"));
    expect(view.homeServices.bookings[0]).toMatchObject({ title: "Plumber booked", provider: "Bayside Plumbing Co.", status: "Booked" });
    expect(view.medication).toMatchObject({ denied: true });
  });
});
