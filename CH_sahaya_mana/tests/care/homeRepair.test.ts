import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@/agents/base/types";
import { careDefinition } from "@/agents/care/CareAgent";
import { CARE_PROMPT } from "@/agents/care/carePrompt";
import { TOOL_AREA, caregiverMayRead, caregiverMayWrite } from "@/agents/care/accessRules";
import { CALL_YOURSELF, FORBIDDEN_META, guardHomeRepairReply } from "@/agents/care/domain/homeRepairReply";
import { classifyHomeService, detectEmergencies, offerTimeWindows, safetyFor, statusAt } from "@/agents/care/domain/homeServices";
import { GUARDIAN_PROMPT, HOME_REPAIR_WORDING_RULES } from "@/agents/guardian/guardianPrompt";
import { getterdoneConfig } from "@/integrations/getterdone/config";
import { BLOCKED_OPERATIONS, GetterDoneClient } from "@/integrations/getterdone/client";
import { GetterDoneLiveProvider, homeServiceProvider, sandboxProviderAllowed } from "@/integrations/getterdone/provider";
import { resolveIntegrations } from "@/integrations/status";
import { checkDeploymentEnv } from "@/lib/security/envCheck";
import { hashValue } from "@/lib/ids";
import { MARGARET, careWorld, daughter, margaret, neighbor } from "./careHelpers";
import { ScriptedLLM, text } from "../helpers";

/** Home repairs: safety first → time windows → approval card → booking only after a consumed approval → status. */
const env = process.env as Record<string, string | undefined>;
const SAVED = ["SAHAYA_HOME_SERVICES", "APP_BASE_URL"].map((k) => [k, env[k]] as const);
beforeEach(() => {
  for (const [k] of SAVED) delete env[k];
});
afterEach(() => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  vi.unstubAllGlobals();
});

type World = Awaited<ReturnType<typeof careWorld>>;
const LEAK = { service: "plumbing", description: "my kitchen sink is leaking under the cabinet" } as const;
const sys = { userId: MARGARET, actor: { id: "agent:care", role: "system" as const } };
const logs = async (w: World) => w.store.listLogs({ userId: MARGARET, agentId: "care", limit: 1000 });
const allText = (v: unknown) => JSON.stringify(v);

async function start(w: World, input: object = LEAK) {
  const r = await w.care.executeTool(margaret, "startHomeRepairRequest", input);
  if (r.status !== "success") throw new Error(JSON.stringify(r));
  return r.output as { requestId: string; trade: string; safety: { emergency: boolean; steps: string[] }; timeWindows: Array<{ windowId: string; label: string }>; next: string };
}
async function choose(w: World, requestId: string, windowId: string) {
  const r = await w.care.executeTool(margaret, "proposeHomeRepairBooking", { requestId, windowId });
  if (r.status !== "approval_required") throw new Error(JSON.stringify(r));
  return r.approval;
}

describe("understanding the request", () => {
  it("routes trades and keeps other Care requests alone", () => {
    expect(classifyHomeService("My kitchen sink is leaking")).toBe("plumbing");
    expect(classifyHomeService("The outlet in the bedroom stopped working")).toBe("electrical");
    expect(classifyHomeService("The washing machine won't drain")).toBe("appliance");
    expect(classifyHomeService("The furnace isn't giving any heat")).toBe("hvac");
    expect(classifyHomeService("My wifi keeps dropping")).toBe("tech");
    expect(classifyHomeService("A cabinet door hinge broke")).toBe("handyman");
    expect(classifyHomeService("I need someone to clean my apartment")).toBe("cleaning");
    expect(classifyHomeService("I'm running out of groceries")).toBeNull();
    expect(detectEmergencies("I smell gas in the kitchen")).toEqual(["gas"]);
    expect(detectEmergencies("there are sparks coming from the outlet")).toEqual(["sparks"]);
    expect(detectEmergencies("the ceiling is sagging and dripping")).toEqual(["ceiling"]);
    expect(detectEmergencies("water is pouring in, it's flooding")).toContain("flooding");
  });

  it("leak: the three plain safety steps come first", () => {
    const s = safetyFor("plumbing", "the pipe under the sink is leaking");
    expect(s.emergency).toBe(false);
    expect(s.steps[0]).toMatch(/turn off the valve under the sink or toilet, or the main water shutoff/);
    expect(s.steps[1]).toMatch(/outlets and anything electrical near the water/);
    expect(s.steps[2]).toMatch(/Move valuables/);
  });

  it.each([
    ["gas", "I smell gas near the stove"],
    ["sparks", "the outlet is sparking"],
    ["ceiling", "the bathroom ceiling is sagging"],
    ["flooding", "the basement is flooding fast"],
  ])("emergency (%s): get out and call 911 or the utility, before anything else", (_k, sentence) => {
    const s = safetyFor(classifyHomeService(sentence) ?? "handyman", sentence);
    expect(s.emergency).toBe(true);
    expect(s.steps[0]).toMatch(/get out/i);
    expect(s.steps[0]).toMatch(/911/);
    expect(s.steps[0]).toMatch(/company/);
  });

  it("offers three two-hour arrival windows, at least two hours ahead", async () => {
    const w = await careWorld();
    const out = await start(w);
    expect(out.timeWindows).toHaveLength(3);
    expect(out.trade).toBe("Plumber");
    expect(out.safety.steps.length).toBe(3);
    expect(out.next).toMatch(/safety steps first/);
    expect(out.next).toMatch(/arrange a plumber/);
    for (const win of offerTimeWindows(w.clock.now(), "America/Los_Angeles")) {
      expect(win.end - win.start).toBe(2 * 60 * 60_000);
      expect(win.start - w.clock.now()).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    }
    // No booking-related record yet.
    expect((await w.care.getDashboard(margaret)).homeServices).toMatchObject({ pending: null, bookings: [] });
  });
});

describe("approval card and booking", () => {
  it("after a time is chosen: one approval card with service, issue, time, provider and cost — nothing booked yet", async () => {
    const w = await careWorld();
    const s = await start(w);
    const approval = await choose(w, s.requestId, s.timeWindows[0].windowId);
    expect(approval.toolName).toBe("bookHomeRepair");
    expect(approval.summary).toContain("Plumbing repair");
    expect(approval.summary).toContain("My kitchen sink is leaking under the cabinet");
    expect(approval.summary).toContain(s.timeWindows[0].label);
    expect(approval.summary).toContain("Bayside Plumbing Co.");
    expect(approval.summary).toContain("estimated $150.00");
    const dash = await w.care.getDashboard(margaret);
    const hs = dash.homeServices as { pending: Record<string, unknown>; bookings: unknown[] };
    expect(hs.pending).toMatchObject({ approvalId: approval.id, provider: "Bayside Plumbing Co.", cost: "$150.00", time: s.timeWindows[0].label });
    expect(hs.bookings).toEqual([]);
  });

  it("only Approve books: provider adapter → 'Plumber booked' with provider, arrival window, reference and status", async () => {
    const w = await careWorld();
    const s = await start(w);
    const approval = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const { result } = await w.care.resolveApproval(margaret, approval.id, "approve");
    expect(result?.status).toBe("success");
    const card = (result as { output: Record<string, string> }).output;
    expect(card).toMatchObject({ title: "Plumber booked", provider: "Bayside Plumbing Co.", arrivalWindow: s.timeWindows[0].label, status: "Booked" });
    expect(card.reference).toMatch(/^GD-[0-9A-F]{4}-[0-9A-F]{4}$/);
    const hs = (await w.care.getDashboard(margaret)).homeServices as unknown as { pending: unknown; bookings: Array<Record<string, string>> };
    expect(hs.pending).toBeNull();
    expect(hs.bookings[0]).toMatchObject({ title: "Plumber booked", reference: card.reference });
    const messages = (await logs(w)).map((l) => l.message);
    for (const m of ["Home repair request started", "Home repair proposal created", "Home repair approval requested", "Approved bookHomeRepair", "Home repair booking created"]) expect(messages).toContain(m);
    expect(allText(await logs(w))).not.toMatch(/kitchen sink is leaking/);
  });

  it("booking WITHOUT approval fails: the tool only ever returns the pending approval (person or system actor)", async () => {
    const w = await careWorld();
    const s = await start(w);
    const approval = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const input = approval.input as Record<string, unknown>;
    for (const who of [margaret, sys]) {
      const r = await w.care.executeTool(who, "bookHomeRepair", input);
      expect(r.status).toBe("approval_required");
      expect((r as { approval: ApprovalRequest }).approval.id).toBe(approval.id);
    }
    expect(((await w.care.getDashboard(margaret)).homeServices as unknown as { bookings: unknown[] }).bookings).toEqual([]);
  });

  it("reused, forged and expired approvals are rejected and audited", async () => {
    const w = await careWorld();
    const s = await start(w);
    const approval = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const input = approval.input as Record<string, unknown>;
    await w.care.resolveApproval(margaret, approval.id, "approve");
    // Reused (already consumed)
    expect(await w.care.executeTool(sys, "bookHomeRepair", input, { approvalId: approval.id })).toMatchObject({ status: "error" });
    await expect(w.care.resolveApproval(margaret, approval.id, "approve")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    // Forged: an "approved" record for different details (another provider)
    const s2 = await start(w, { service: "electrical", description: "the hallway outlet stopped working" });
    const a2 = await choose(w, s2.requestId, s2.timeWindows[1].windowId);
    const forgedInput = { ...(a2.input as Record<string, unknown>), provider: "Someone Else" };
    const forged: ApprovalRequest = { ...a2, id: "apr_forged_1", input: forgedInput, inputHash: hashValue(forgedInput), status: "approved" };
    await w.store.saveApproval(forged);
    expect(await w.care.executeTool(sys, "bookHomeRepair", forgedInput, { approvalId: forged.id })).toMatchObject({ status: "error", code: "APPROVAL_INVALID" });
    // Expired
    w.clock.advance(25 * 60 * 60_000);
    await expect(w.care.resolveApproval(margaret, a2.id, "approve")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    const rejected = (await logs(w)).filter((l) => l.message === "Home repair booking attempt rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    const bookings = ((await w.care.getDashboard(margaret)).homeServices as unknown as { bookings: unknown[] }).bookings;
    expect(bookings).toHaveLength(1);
  });

  it("Change time voids the old approval and issues a new one; the old one can't be used", async () => {
    const w = await careWorld();
    const s = await start(w);
    const first = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const second = await choose(w, s.requestId, s.timeWindows[1].windowId);
    expect(second.id).not.toBe(first.id);
    expect((await w.store.getApproval(first.id))?.status).toBe("expired");
    await expect(w.care.resolveApproval(margaret, first.id, "approve")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    expect(await w.care.executeTool(sys, "bookHomeRepair", first.input, { approvalId: first.id })).toMatchObject({ status: "error" });
    expect((await logs(w)).map((l) => l.message)).toContain("Home repair time changed");
    const { result } = await w.care.resolveApproval(margaret, second.id, "approve");
    expect((result as { output: { arrivalWindow: string } }).output.arrivalWindow).toBe(s.timeWindows[1].label);
  });

  it("Decline closes the request; nothing is booked", async () => {
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    await w.care.resolveApproval(margaret, a.id, "deny");
    const hs = (await w.care.getDashboard(margaret)).homeServices as unknown as { pending: unknown; bookings: unknown[] };
    expect(hs.pending).toBeNull();
    expect(hs.bookings).toEqual([]);
    expect((await logs(w)).map((l) => l.message)).toContain("Home repair request declined");
  });

  it("concurrent approvals book once", async () => {
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const r = await Promise.allSettled([w.care.resolveApproval(margaret, a.id, "approve"), w.care.resolveApproval(margaret, a.id, "approve")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await logs(w)).filter((l) => l.message === "Home repair booking created")).toHaveLength(1);
  });

  it("status follows the clock: Booked → On the way → Done (audited)", async () => {
    const w = await careWorld();
    const s = await start(w);
    const win = s.timeWindows[0];
    const a = await choose(w, s.requestId, win.windowId);
    await w.care.resolveApproval(margaret, a.id, "approve");
    const status = async () => ((await w.care.getDashboard(margaret)).homeServices as unknown as { bookings: Array<{ status: string }> }).bookings[0].status;
    expect(await status()).toBe("Booked");
    const tz = "America/Los_Angeles";
    const wnd = offerTimeWindows(w.clock.now(), tz).find((x) => x.windowId === win.windowId)!;
    w.clock.advance(wnd.start - 20 * 60_000 - w.clock.now());
    expect(await status()).toBe("On the way");
    w.clock.advance(wnd.end + 1 - w.clock.now());
    expect(await status()).toBe("Done");
    expect(statusAt(wnd, wnd.start - 31 * 60_000)).toBe("booked");
    const changes = (await logs(w)).filter((l) => l.message === "Home repair status changed");
    expect(changes.map((l) => (l.data as { status: string }).status)).toEqual(["on_the_way", "done"]);
  });
});

describe("wording rules (prompt + server-side check)", () => {
  it("rules live in guardianPrompt.ts and are included in Care's prompt; Guardian keeps the safety part", () => {
    expect(HOME_REPAIR_WORDING_RULES).toMatch(/Never tell the person to call, contact, find or hire a plumber/);
    expect(HOME_REPAIR_WORDING_RULES).toMatch(/get out now and call 911 or the utility/);
    expect(CARE_PROMPT).toContain(HOME_REPAIR_WORDING_RULES);
    expect(GUARDIAN_PROMPT).toMatch(/get out now and call 911 or the utility/);
  });

  it("no meta words in tool output, approval cards, booking cards or the person's dashboard", async () => {
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const booked = await w.care.resolveApproval(margaret, a.id, "approve");
    const dash = await w.care.getDashboard(margaret);
    for (const v of [s, a.summary, booked.result, dash.homeServices, careDefinition.tools.filter((t) => /HomeRepair/.test(t.name)).map((t) => t.description)]) {
      expect(allText(v)).not.toMatch(FORBIDDEN_META);
    }
  });

  it("detects 'call a plumber yourself' phrasing but allows offers and emergency calls", () => {
    for (const bad of ["You should call a plumber.", "Call an electrician today.", "I'd recommend contacting a local handyman.", "Please call a plumber as soon as you can.", "You may want to find a technician."]) expect(CALL_YOURSELF.test(bad), bad).toBe(true);
    for (const ok of ["I can arrange a plumber for you.", "I can book a plumber for you.", "Call 911 or your gas company from outside.", "Do you want me to find a plumber?"]) expect(CALL_YOURSELF.test(ok), ok).toBe(false);
  });

  it("the server removes meta talk, 'call a plumber yourself' and premature 'booked' claims from Care's reply; safety stays", async () => {
    const llm = new ScriptedLLM([
      text("Turn off the valve under the sink if it's safe. You should call a plumber as soon as possible. This is a demo, so no one will come. I've booked a plumber for tomorrow. Which time suits you: tomorrow 9–11 am or 12–2 pm?"),
    ]);
    const w = await careWorld({ llm });
    const r = await w.care.processMessage(margaret, "My kitchen sink is leaking");
    expect(r.reply).toMatch(/Turn off the valve/);
    expect(r.reply).toMatch(/Which time suits you/);
    expect(r.reply).not.toMatch(FORBIDDEN_META);
    expect(CALL_YOURSELF.test(r.reply)).toBe(false);
    expect(r.reply).not.toMatch(/I've booked/);
    // The stored conversation has the checked text too.
    const conv = await w.care.listConversation(margaret);
    expect(allText(conv.filter((m) => m.role === "assistant"))).not.toMatch(/no one will come/);
    expect((await logs(w)).map((l) => l.message)).toContain("Home repair reply adjusted to the wording rules");
  });

  it("emergency guidance is always present: added first if the reply forgot it", async () => {
    const llm = new ScriptedLLM([text("I can arrange someone to look at it. Which time suits you?")]);
    const w = await careWorld({ llm });
    const r = await w.care.processMessage(margaret, "I smell gas in the kitchen");
    expect(r.reply.split("\n")[0]).toMatch(/get out of the house now/i);
    expect(r.reply).toMatch(/911/);
    // and the hint told the model to lead with it
    expect(allText(llm.requests[0].messages.at(-1))).toContain("<home_repair>");
  });

  it("other Care topics are not filtered (grocery honesty rules unchanged)", async () => {
    const llm = new ScriptedLLM([text("Your order was simulated — nothing was bought.")]);
    const w = await careWorld({ llm });
    const r = await w.care.processMessage(margaret, "Did my grocery order go through?");
    expect(r.reply).toBe("Your order was simulated — nothing was bought.");
  });

  it("guard helper keeps safety text and falls back to an offer when everything else was removed", () => {
    const g = guardHomeRepairReply("This is a sandbox booking.", "my toilet is leaking", { bookingConfirmed: false });
    expect(g.text).toBe("I can arrange that for you. Which time suits you best?");
  });
});

describe("caregivers", () => {
  it("default deny: approve scopes don't show home repairs; nobody but the person can approve, change or decline", async () => {
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    for (const who of [daughter, neighbor]) {
      const d = await w.care.getDashboard(who);
      expect(d.homeServices).toMatchObject({ denied: true });
      expect(d.support.approvals.map((x) => x.id)).not.toContain(a.id);
    }
    await expect(w.care.resolveApproval(daughter, a.id, "approve")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(w.care.resolveApproval(daughter, a.id, "deny")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await w.care.executeTool(daughter, "proposeHomeRepairBooking", { requestId: s.requestId, windowId: s.timeWindows[1].windowId })).toMatchObject({ status: "error", code: "PERMISSION_DENIED" });
    expect(await w.care.executeTool(daughter, "startHomeRepairRequest", LEAK)).toMatchObject({ status: "error", code: "PERMISSION_DENIED" });
    expect(TOOL_AREA.bookHomeRepair).toBeUndefined();
  });

  it("the view-only care:home-services scope shows bookings (provider, window, reference, status) and nothing else", async () => {
    const w = await careWorld();
    await w.store.setCaregiverPermission({ userId: MARGARET, caregiverId: "cg_home_viewer", agentId: "care", canViewSummaries: true, canApprove: false, scopes: ["care:home-services"] });
    const viewer = { userId: MARGARET, actor: { id: "cg_home_viewer", role: "caregiver" as const } };
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    let d = await w.care.getDashboard(viewer);
    expect(d.homeServices).toEqual({ bookings: [] }); // nothing about a booking before approval
    expect(d.support.approvals).toEqual([]);
    await expect(w.care.resolveApproval(viewer, a.id, "approve")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await w.care.resolveApproval(margaret, a.id, "approve");
    d = await w.care.getDashboard(viewer);
    const b = (d.homeServices as { bookings: Array<Record<string, string>> }).bookings[0];
    expect(b).toMatchObject({ title: "Plumber booked", provider: "Bayside Plumbing Co.", status: "Booked" });
    expect(d.medication).toMatchObject({ denied: true });
    expect(d.grocery).toMatchObject({ denied: true });
    const g = { canViewSummaries: true, canApprove: false, scopes: ["care:home-services"] };
    expect(caregiverMayRead(g, "care.homeServices", { kind: "booking" })).toBe(true);
    expect(caregiverMayRead(g, "care.homeServices", { kind: "proposal" })).toBe(false);
    expect(caregiverMayRead(g, "care.homeServices", { kind: "request" })).toBe(false);
    expect(caregiverMayRead({ ...g, scopes: ["care:grocery", "care:grocery:approve"], canApprove: true }, "care.homeServices", { kind: "booking" })).toBe(false);
    expect(caregiverMayWrite(g, "care.homeServices", { kind: "booking" })).toBe(false);
  });
});

describe("provider adapter and production safeguard", () => {
  it("sandbox provider is refused in production configuration (except loopback), and the server refuses to start", () => {
    expect(sandboxProviderAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(sandboxProviderAllowed({ NODE_ENV: "production", APP_BASE_URL: "http://localhost:3000" })).toBe(true);
    expect(sandboxProviderAllowed({ NODE_ENV: "production", APP_BASE_URL: "https://sahaya.example.org" })).toBe(false);
    expect(() => homeServiceProvider({ NODE_ENV: "production", APP_BASE_URL: "https://sahaya.example.org" })).toThrow();
    expect(() => homeServiceProvider({ SAHAYA_HOME_SERVICES: "off" })).toThrow();
    expect(checkDeploymentEnv({ NODE_ENV: "production", APP_BASE_URL: "https://sahaya.example.org" }).map((p) => p.code)).toContain("SANDBOX_PROVIDER");
    expect(checkDeploymentEnv({ NODE_ENV: "production", APP_BASE_URL: "https://sahaya.example.org", SAHAYA_HOME_SERVICES: "off" }).map((p) => p.code)).not.toContain("SANDBOX_PROVIDER");
  });

  it("switched off: the tools refuse plainly", async () => {
    env.SAHAYA_HOME_SERVICES = "off";
    const w = await careWorld();
    expect(await w.care.executeTool(margaret, "startHomeRepairRequest", LEAK)).toMatchObject({ status: "error", code: "INTEGRATION_UNAVAILABLE" });
  });

  it("'sandbox' appears only in the integration status badge", () => {
    const s = resolveIntegrations({}).find((i) => i.id === "getterdone")!;
    expect(s.mode).toBe("sandbox");
    expect(s.detail).toMatch(/Sandbox provider/);
  });

  it("the real GetterDone side stays locked: no task creation, payment or worker contact; no network", async () => {
    const fetchImpl = vi.fn();
    const client = new GetterDoneClient(getterdoneConfig({ GETTERDONE_API_KEY: "gd_agent_x:gd_secret_y", GETTERDONE_LIVE_QUOTES: "true", GETTERDONE_DEMO_MODE: "false" }), fetchImpl as never);
    for (const op of BLOCKED_OPERATIONS) await expect(client.request(op.method, op.path.replace("{id}", "t1"), {})).rejects.toMatchObject({ code: "DEMO_MODE_BLOCKED" });
    await expect(new GetterDoneLiveProvider(client).book()).rejects.toMatchObject({ code: "DEMO_MODE_BLOCKED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const sandboxFetch = vi.fn();
    vi.stubGlobal("fetch", sandboxFetch);
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    await w.care.resolveApproval(margaret, a.id, "approve");
    expect(sandboxFetch).not.toHaveBeenCalled();
  });

  it("no scheduled job or event route can book", async () => {
    expect(careDefinition.jobKinds).toEqual(["medication_reminder"]);
    const routes = [...(careDefinition.events?.inbound ?? []), ...(careDefinition.events?.outbound ?? [])].map((r) => r.type);
    expect(routes.some((t) => /home|repair|getterdone/i.test(t))).toBe(false);
    const w = await careWorld();
    const s = await start(w);
    await choose(w, s.requestId, s.timeWindows[0].windowId);
    await w.runtime.runDueJobs();
    expect(((await w.care.getDashboard(margaret)).homeServices as unknown as { bookings: unknown[] }).bookings).toEqual([]);
  });

  it("another person's ids don't work", async () => {
    const w = await careWorld();
    const s = await start(w);
    const a = await choose(w, s.requestId, s.timeWindows[0].windowId);
    const other = { userId: "user_other", actor: { id: "user_other", role: "older_adult" as const } };
    expect(await w.care.executeTool(other, "proposeHomeRepairBooking", { requestId: s.requestId, windowId: s.timeWindows[0].windowId })).toMatchObject({ status: "error", code: "NOT_FOUND" });
    await expect(w.care.resolveApproval(other, a.id, "approve")).rejects.toBeTruthy();
  });
});
