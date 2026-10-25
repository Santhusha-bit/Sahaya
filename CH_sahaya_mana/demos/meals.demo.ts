import { expect, it } from "vitest";
import { daughter, demoWorld, margaret, say } from "./demoWorld";

it("Demo C — meals, cooking help and caregiver support", async () => {
  const w = await demoWorld();
  const tool = async (name: string, input: unknown, ctx = margaret) => {
    say.intent(name, input);
    const r = await w.care.executeTool(ctx, name, input);
    if (r.status === "error") throw new Error(`${name}: ${r.error}`);
    return r;
  };
  w.clock.advanceMinutes(9 * 60 + 35); // 5:30 PM
  say.title("Demo C — What's for dinner, step-by-step cooking, and asking for help");
  say.clock(w.clock.now());

  say.step(1, "Inspect Margaret's (fictional) pantry");
  const pantry = (await tool("getPantry", {})) as { output: { items: Array<{ name: string; quantity: number; unit: string; expiresOn: string | null; allergenInfo: string }>; expiringSoon: Array<{ name: string; expiresOn: string }> } };
  for (const i of pantry.output.items) say.info(`• ${i.name} — ${i.quantity} ${i.unit}${i.expiresOn ? ` (use by ${i.expiresOn})` : ""}${i.allergenInfo !== "complete" ? " [allergen info unknown]" : ""}`);

  say.step(2, "Items approaching expiration");
  for (const i of pantry.output.expiringSoon) say.warn(`${i.name} — use by ${i.expiresOn}`);
  expect(pantry.output.expiringSoon.length).toBeGreaterThanOrEqual(3);

  say.step(3, "Three dinner ideas from what she has and what she likes");
  say.user("Margaret", "What can I make for dinner?");
  const meals = (await tool("suggestMeals", { mealType: "dinner" })) as { output: { ideas: Array<{ recipeId: string; name: string; minutes: number; uses: string[]; usesExpiring: string[]; missing: string[] }>; excluded: Array<{ name: string; reasons: string[] }>; note: string } };
  meals.output.ideas.forEach((m, i) =>
    say.info(`${i + 1}. ${m.name} (${m.minutes} min) — uses ${m.uses.join(", ")}${m.usesExpiring.length ? ` · uses up: ${m.usesExpiring.join(", ")}` : ""}${m.missing.length ? ` · needs: ${m.missing.join(", ")}` : ""}`),
  );
  expect(meals.output.ideas).toHaveLength(3);
  say.info(meals.output.note);

  say.step(4, "The same allergy and diet filter as groceries is applied");
  for (const e of meals.output.excluded) say.blocked(`${e.name}: ${e.reasons.join("; ")}`);
  expect(meals.output.excluded.some((e) => /peanut/.test(e.reasons.join()))).toBe(true);
  expect(meals.output.excluded.some((e) => /allergen information/.test(e.reasons.join()))).toBe(true);

  say.step(5, "Care walks her through one recipe, one step at a time (simulated voice)");
  const pick = meals.output.ideas.find((m) => m.recipeId === "r_spinach_omelette") ?? meals.output.ideas[0];
  say.user("Margaret", `Let's make the ${pick.name.toLowerCase()}.`);
  const started = (await tool("startCooking", { recipeId: pick.recipeId })) as { output: { say: string } };
  say.care(started.output.say);

  say.step(6, "“Repeat” and “next”");
  for (const utterance of ["Can you repeat that?", "Next", "Slow down, please", "Next"]) {
    say.user("Margaret", utterance);
    const r = await w.care.cookingVoice(margaret, utterance);
    if (r.kind === "step") say.care(r.say);
  }
  const view1 = await w.care.getDashboard(margaret);
  expect((view1.meals as { cooking: { step: number } }).cooking.step).toBe(3);

  say.step(7, "Margaret says cooking is becoming difficult");
  say.user("Margaret", "Honestly, cooking is becoming difficult for me.");
  const support = await w.care.cookingVoice(margaret, "Honestly, cooking is becoming difficult for me.");
  expect(support.kind).toBe("support_offered");
  if (support.kind !== "support_offered") return;
  say.care(support.message);
  for (const o of support.options) say.info(`• ${o.label} — needs ${o.needs}`);

  say.step(8, "She chooses to ask her caregiver; Care prepares the request and asks for her consent");
  say.user("Margaret", "Yes, please ask Ellen if she can help with meals.");
  const input = { need: "home_task", summary: "Margaret would like help preparing meals a few evenings a week; cooking has become difficult." };
  const req = await tool("requestPhysicalAssistance", input);
  if (req.status !== "approval_required") throw new Error("expected consent request");
  say.info(`Consent card for Margaret: “${req.approval.summary}”`);
  await expect(w.care.decide(daughter, req.approval.id, "approve")).rejects.toThrow(/only the user/);
  say.blocked("Ellen can't give consent on Margaret's behalf — only Margaret can");
  const first = await w.care.decide(margaret, req.approval.id, "approve");
  const firstOut = (first.result as { output: { status: string; message: string } }).output;
  say.warn(`Margaret consented, but: ${firstOut.message}`);
  expect(firstOut.status).toBe("route_disabled");

  say.step(9, "With the Care → Guardian route enabled, the request goes through the event bus");
  await w.runtime.setConsent(margaret, "care", "guardian", "physical_assistance_request", true);
  say.ok("Margaret enables her consent setting for “Care → Guardian: in-person help requests”");
  const again = await tool("requestPhysicalAssistance", input);
  if (again.status !== "approval_required") throw new Error();
  const sent = await w.care.decide(margaret, again.approval.id, "approve");
  const out = (sent.result as { output: { status: string; eventId: string; message: string } }).output;
  expect(out.status).toBe("sent");
  say.care(out.message);
  const event = (await w.store.getEvent(out.eventId))!;
  say.info(`Event ${event.type}: ${event.sourceAgent} → ${event.targetAgent}, status ${event.status}, payload ${JSON.stringify(event.payload)}`);
  const [task] = await w.runtime.get("guardian").listTasks(margaret);
  say.ok(`Guardian planned its own task: “${task.title}” (${task.status}) — telephony is unavailable, so a person follows up; nothing was claimed as sent`);
});
