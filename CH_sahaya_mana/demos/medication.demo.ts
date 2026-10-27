import { expect, it } from "vitest";
import { DEMO_MEDS } from "@/agents/care/data/demoProfile";
import { extractPillCount } from "@/agents/care/domain/language";
import { daughter, demoWorld, margaret, neighbor, say } from "./demoWorld";

it("Demo A — medication reminder, check-in and refill", async () => {
  const w = await demoWorld();
  const morningDose = async () =>
    (await w.services().meds.ensureDoses(margaret.userId)).find((d) => d.medicationId === DEMO_MEDS.morning && d.localDate === "2026-10-26")!;
  const supply = async () => (await w.services().env.repo.medication(margaret.userId, DEMO_MEDS.morning)).pillsRemaining;
  const newPrompts = async (from: number) => (await w.services().env.repo.voiceLog(margaret.userId)).slice(from).filter((u) => u.direction === "to_user");
  let seen = 0;
  const speak = async () => {
    const p = await newPrompts(seen);
    seen = (await w.services().env.repo.voiceLog(margaret.userId)).length;
    for (const u of p) say.care(u.text);
  };

  say.title("Demo A — Margaret's morning medication, check-in and refill");
  say.info("Margaret, 78 (fictional), takes Calmapril 10 mg (fictional) at 08:00. Supply estimate: 7 tablets.");

  say.step(1, "The morning reminder is triggered by the scheduler");
  w.clock.advanceMinutes(5);
  say.clock(w.clock.now());
  await w.care.tick(margaret);
  await speak();
  expect((await morningDose()).state).toBe("reminded");
  say.ok("Dose state: reminded (voice prompt recorded by the sandbox voice simulator — no call placed)");

  say.step(2, "No answer, so the dose stays unconfirmed and Care follows up");
  w.clock.advanceMinutes(20);
  say.clock(w.clock.now());
  await w.care.tick(margaret);
  await speak();
  expect((await morningDose()).state).toBe("unconfirmed");
  say.ok("Dose state: unconfirmed — silence is never treated as taken");

  say.step(3, "Still no answer: Care starts a check-in conversation");
  w.clock.advanceMinutes(25);
  say.clock(w.clock.now());
  await w.care.tick(margaret);
  await speak();
  expect((await morningDose()).state).toBe("checked_in");
  say.ok("Dose state: checked_in");

  say.step(4, "Margaret says she forgot — then confirms only after she has taken it");
  say.user("Margaret", "Oh, I forgot! I'm taking it now.");
  const r1 = await w.care.medicationVoiceReply(margaret, "Oh, I forgot! I'm taking it now.");
  await speak();
  expect(r1.kind).toBe("recorded");
  expect((await morningDose()).state).toBe("checked_in");
  expect(await supply()).toBe(7);
  say.ok("Recorded as “not taken yet”. Dose NOT confirmed, supply unchanged (7).");
  w.clock.advanceMinutes(3);
  say.user("Margaret", "Yes, I've taken it now.");
  const r2 = await w.care.medicationVoiceReply(margaret, "Yes, I've taken it now.");
  await speak();
  expect(r2).toMatchObject({ kind: "confirmation", status: "confirmed" });
  say.ok(`Dose confirmed at the user's explicit word (on time). Supply estimate 7 → ${await supply()}.`);

  say.step(5, "She reports having two pills left");
  say.user("Margaret", "I only have two pills left.");
  const count = extractPillCount("I only have two pills left.")!;
  say.intent("reportPillCount", { medicationId: DEMO_MEDS.morning, count });
  const pending = await w.care.reportPillCount(margaret, DEMO_MEDS.morning, count);
  say.care(pending.question);
  expect(await supply()).toBe(6);
  say.user("Margaret", "Yes, that's right.");

  say.step(6, "Care updates the estimate and checks the refill threshold");
  const applied = await w.care.confirmPillCount(margaret, pending.pendingId, "Yes, that's right.");
  say.care(applied.message);
  expect(applied).toMatchObject({ applied: true, pillsRemaining: 2, daysOfSupply: 2, refillNeeded: true });
  say.ok(`Supply 2 tablets ≈ 2 days; refill lead time is 5 days → refill needed`);

  say.step(7, "A refill draft is prepared from stored information only");
  const [draft] = await w.services().env.repo.refills(margaret.userId);
  expect(draft).toMatchObject({ status: "draft", quantity: 30, missing: [] });
  say.info(`Medication: ${draft.medicationName}`);
  say.info(`Quantity: ${draft.quantity} (from the last fill on ${draft.lastFill?.date}) · Rx ${draft.rxNumber}`);
  say.info(`Pharmacy: ${draft.pharmacy?.name} · Refills remaining on record: ${draft.refillsRemaining} · ${draft.fulfillment}`);
  const pendingApprovals = await w.care.listApprovals(margaret);
  expect(pendingApprovals.filter((a) => a.toolName === "submitPharmacyRefill")).toHaveLength(1);
  say.ok("Approval request opened (single-use, bound to these exact details, expires in 24 h)");

  say.step(8, "Her daughter reviews the draft on her dashboard and approves it");
  const view = await w.care.getDashboard(daughter);
  const approval = view.support.approvals.find((a) => a.toolName === "submitPharmacyRefill")!;
  say.info(`Ellen sees: “${approval.summary}” — can approve: ${approval.canDecide}`);
  const neighborView = await w.care.getDashboard(neighbor);
  expect(neighborView.medication).toMatchObject({ denied: true });
  await expect(w.care.decide(neighbor, approval.id, "approve")).rejects.toThrow(/may not approve/);
  say.blocked("Sam (grocery-only neighbor) can't see medication data or approve the refill — enforced on the server");
  const decided = await w.care.decide(daughter, approval.id, "approve");
  expect(decided.result).toMatchObject({ status: "success", output: { status: "submitted", simulated: true } });
  say.ok("Approved by Ellen; approval verified server-side and consumed at execution");

  say.step(9, "The sandbox pharmacy accepts the request");
  say.info(`Status: submitted — ${(decided.result as { output: { note: string } }).output.note}`);
  w.clock.advanceMinutes(125);
  say.clock(w.clock.now());
  await w.care.tick(margaret);
  const refill = (await w.services().env.repo.refills(margaret.userId))[0];
  expect(refill.status).toBe("ready");
  say.ok("Sandbox pharmacy status: ready for pickup (simulated)");

  say.step(10, "The caregiver dashboard reflects the refill status");
  const final = await w.care.getDashboard(daughter);
  const med = final.medication as { refills: Array<{ medication: string; status: string; pharmacy: string }>; today: Array<{ name: string; pillsRemaining: number; doses: Array<{ slot: string; state: string }> }> };
  for (const m of med.today) say.info(`${m.name}: ${m.doses.map((d) => `${d.slot} ${d.state}`).join(", ")} · ${m.pillsRemaining} left`);
  for (const r of med.refills) say.info(`Refill: ${r.medication} → ${r.status} at ${r.pharmacy}`);
  for (const a of final.support.alerts) say.info(`Alert: ${a.title}`);
  expect(med.refills[0].status).toBe("ready");
  say.ok("Done. Nothing was sent to a real pharmacy; no calls were placed.");
});
