import { expect, it } from "vitest";
import { classifyHomeService, detectEmergencies, windowFor } from "@/agents/care/domain/homeServices";
import { FORBIDDEN_META, guardHomeRepairReply } from "@/agents/care/domain/homeRepairReply";
import { daughter, demoWorld, margaret, say, USER_ID } from "./demoWorld";

/**
 * Demo E — home repairs. Safety first → Care offers to arrange it with 2–3 times → approval card → booking only after
 * Approve (provider adapter: GetterDone sandbox, in-app; nothing is sent to GetterDone) → status by the demo clock.
 */
type Start = { requestId: string; trade: string; safety: { emergency: boolean; steps: string[] }; timeWindows: Array<{ windowId: string; label: string }> };

it("Demo E1 — leaking kitchen sink → plumber booked", async () => {
  const w = await demoWorld();
  const run = async (tool: string, input: unknown, ctx = margaret) => {
    say.intent(tool, input);
    return w.care.executeTool(ctx, tool, input);
  };
  say.title("Demo E1 — a leaking kitchen sink");
  say.clock(w.clock.now());

  say.step(1, "Margaret describes the problem");
  const utterance = "My kitchen sink is leaking under the cabinet.";
  say.user("Margaret", utterance);
  expect(classifyHomeService(utterance)).toBe("plumbing");
  const started = await run("startHomeRepairRequest", { service: "plumbing", description: "kitchen sink leaking under the cabinet" });
  if (started.status !== "success") throw new Error(JSON.stringify(started));
  const s = started.output as Start;

  say.step(2, "Safety steps first, then Care offers to arrange it and asks one thing");
  const reply = `${s.safety.steps.join(" ")}\nI can arrange a plumber for you. Which time suits you: ${s.timeWindows.map((t) => t.label).join(", or ")}?`;
  say.care(reply);
  expect(reply).not.toMatch(FORBIDDEN_META);

  say.step(3, "She picks a time; the approval card appears (nothing is booked yet)");
  say.user("Margaret", `${s.timeWindows[1].label}, please.`);
  const chosen = await run("proposeHomeRepairBooking", { requestId: s.requestId, windowId: s.timeWindows[1].windowId });
  if (chosen.status !== "approval_required") throw new Error(JSON.stringify(chosen));
  say.info(`Approval card: ${chosen.approval.summary}`);
  say.info("Buttons: Approve · Change time · Decline");
  say.care("I've put the details on your screen. Tap Approve when you're happy, or change the time.");

  say.step(4, "She changes the time — the old approval stops working, a new card appears");
  const changed = await run("proposeHomeRepairBooking", { requestId: s.requestId, windowId: s.timeWindows[0].windowId });
  if (changed.status !== "approval_required") throw new Error(JSON.stringify(changed));
  await expect(w.care.resolveApproval(margaret, chosen.approval.id, "approve")).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  say.blocked("The first card can no longer be approved");
  say.info(`New card: ${changed.approval.summary}`);
  const direct = await run("bookHomeRepair", changed.approval.input);
  expect(direct.status).toBe("approval_required");
  say.blocked("Trying to book without tapping Approve only returns the same card");
  await expect(w.care.resolveApproval(daughter, changed.approval.id, "approve")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  say.blocked("Her daughter can't approve it — only Margaret can");

  say.step(5, "Margaret taps Approve → the provider adapter books the visit");
  const { result } = await w.care.resolveApproval(margaret, changed.approval.id, "approve");
  const card = (result as { output: Record<string, string> }).output;
  expect(card.title).toBe("Plumber booked");
  say.ok(`${card.title} — ${card.provider}, arriving ${card.arrivalWindow}, reference ${card.reference}, status ${card.status}`);
  expect(JSON.stringify(card)).not.toMatch(FORBIDDEN_META);

  say.step(6, "The demo clock moves the status along");
  const status = async () => ((await w.care.getDashboard(margaret)).homeServices as unknown as { bookings: Array<{ status: string }> }).bookings[0].status;
  say.info(`Now: ${await status()}`);
  const win = windowFor((changed.approval.input as { windowId: string }).windowId, w.clock.now(), "America/Los_Angeles")!;
  w.clock.advance(win.start - 20 * 60_000 - w.clock.now());
  say.clock(w.clock.now());
  say.info(`20 minutes before the window: ${await status()}`);
  w.clock.advance(win.end + 60_000 - w.clock.now());
  say.clock(w.clock.now());
  const done = await status();
  say.ok(`Finally: ${done}`);
  expect(done).toBe("Done");

  say.step(7, "Audit trail (ids only)");
  for (const l of (await w.store.listLogs({ userId: USER_ID, agentId: "care", limit: 500 })).filter((x) => x.message.startsWith("Home repair") || x.message === "Approved bookHomeRepair")) say.info(`• ${l.message}`);
});

it("Demo E2 — gas smell: get out first", async () => {
  say.title("Demo E2 — a gas smell");
  const utterance = "I smell gas in the kitchen and the stove isn't lighting.";
  say.user("Margaret", utterance);
  expect(detectEmergencies(utterance)).toEqual(["gas"]);
  const modelDraft = "I can arrange an appliance technician. Which time suits you?";
  const checked = guardHomeRepairReply(modelDraft, utterance, { bookingConfirmed: false });
  say.care(checked.text);
  expect(checked.text.split("\n")[0]).toMatch(/get out of the house now/i);
  say.ok("Emergency guidance comes first, even if the model forgot it");
  const bad = guardHomeRepairReply("You should call a plumber. This is a demo so nobody will come.", "my toilet is leaking", { bookingConfirmed: false });
  say.care(bad.text);
  expect(bad.text).not.toMatch(FORBIDDEN_META);
  say.ok("'Call a plumber yourself' and system talk are removed by the server");
});
