import { describe, expect, it } from "vitest";
import { RECIPES, recipeById } from "@/agents/care/data/recipes";
import { applyCookingCommand, expiringSoon, suggestMeals, type CookingSession } from "@/agents/care/domain/meals";
import { detectCookingDifficulty, parseCookingCommand } from "@/agents/care/domain/language";
import { demoPantry, demoStart, DEMO_PREFERENCES } from "@/agents/care/data/demoProfile";
import { careWorld, daughter, margaret } from "./careHelpers";

const now = demoStart();
const today = "2026-10-26";

describe("pantry and expiry", () => {
  it("lists items expiring within 3 days, soonest first, and flags expired ones", () => {
    const pantry = demoPantry(now);
    const soon = expiringSoon(pantry, today).map((p) => p.name);
    expect(soon.slice(0, 2).sort()).toEqual(["Atlantic Salmon Fillets", "Baby Spinach"]);
    expect(soon).toEqual(expect.arrayContaining(["Large Eggs (6)", "Broccoli Crowns"]));
    expect(soon).not.toContain("Gold Potatoes (3 lb)");
    const expired = expiringSoon([{ ...pantry[0], expiresOn: "2026-10-20" }], today);
    expect(expired[0].expired).toBe(true);
  });
});

describe("meal planning through the shared safety filter", () => {
  it("suggests three dinners that use expiring items and excludes unsafe or unknown recipes", () => {
    const res = suggestMeals(RECIPES, demoPantry(now), DEMO_PREFERENCES.safety, today, { mealType: "dinner" });
    expect(res.ideas).toHaveLength(3);
    expect(res.ideas[0].usesExpiring.length).toBeGreaterThan(0);
    const excluded = Object.fromEntries(res.excluded.map((e) => [e.recipeId, e.reasons.join(" ")]));
    expect(excluded.r_satay_noodles).toMatch(/peanut/);
    expect(excluded.r_cracker_plate).toMatch(/allergen information is missing/);
    expect(res.ideas.map((i) => i.recipeId)).not.toContain("r_satay_noodles");
    expect(res.note).toMatch(/not medical or diet advice/);
  });

  it("excludes a recipe if a required pantry item has unknown allergen data", () => {
    const pantry = demoPantry(now).map((p) => (p.name === "Large Eggs (6)" ? { ...p, allergenInfo: "missing" as const, allergens: null } : p));
    const res = suggestMeals(RECIPES, pantry, DEMO_PREFERENCES.safety, today, { mealType: "dinner", count: 10 });
    expect(res.excluded.map((e) => e.recipeId)).toContain("r_spinach_omelette");
  });

  it("never uses expired items", () => {
    const pantry = demoPantry(now).map((p) => (p.name === "Baby Spinach" ? { ...p, expiresOn: "2026-10-20" } : p));
    const res = suggestMeals(RECIPES, pantry, DEMO_PREFERENCES.safety, today, { count: 10 });
    expect(res.ideas.flatMap((i) => i.uses)).not.toContain("Baby Spinach");
  });
});

describe("step-by-step cooking", () => {
  const recipe = recipeById("r_spinach_omelette")!;
  const start: CookingSession = { id: "c", recipeId: recipe.id, recipeName: recipe.name, stepIndex: 0, totalSteps: recipe.steps.length, pace: "normal", simplified: false, status: "active", startedAt: 0, updatedAt: 0 };

  it("next / repeat / slower / simpler / back / stop, one step at a time", () => {
    let r = applyCookingCommand(start, recipe, "repeat", 1);
    expect(r.say).toMatch(/^Step 1 of 6\. Crack 2 eggs/);
    r = applyCookingCommand(r.session, recipe, "next", 2);
    expect(r.say).toMatch(/^Step 2 of 6/);
    expect(r.say).not.toMatch(/Step 3/);
    r = applyCookingCommand(r.session, recipe, "slower", 3);
    expect(r.say.split("\n").length).toBeGreaterThan(2);
    r = applyCookingCommand(r.session, recipe, "simpler", 4);
    expect(r.say).toContain("Put a little oil in a pan.");
    r = applyCookingCommand(r.session, recipe, "back", 5);
    expect(r.session.stepIndex).toBe(0);
    r = applyCookingCommand(r.session, recipe, "stop", 6);
    expect(r.session.status).toBe("stopped");
  });

  it("finishes after the last step", () => {
    const r = applyCookingCommand({ ...start, stepIndex: recipe.steps.length - 1 }, recipe, "next", 1);
    expect(r.session.status).toBe("finished");
  });

  it("parses voice commands and difficulty", () => {
    expect(parseCookingCommand("Next please")).toBe("next");
    expect(parseCookingCommand("can you say that again")).toBe("repeat");
    expect(parseCookingCommand("slow down")).toBe("slower");
    expect(detectCookingDifficulty("Cooking is becoming difficult for me")).toBe(true);
    expect(detectCookingDifficulty("I love cooking")).toBe(false);
  });

  it("refuses to walk through a recipe the safety filter excludes", async () => {
    const w = await careWorld();
    const res = await w.care.executeTool(margaret, "startCooking", { recipeId: "r_satay_noodles" });
    expect(res).toMatchObject({ status: "error", code: "VALIDATION_FAILED" });
  });
});

describe("pantry updates", () => {
  it("user-reported additions without a product link have unknown allergen info", async () => {
    const w = await careWorld();
    const res = await w.care.executeTool(margaret, "updatePantry", { changes: [{ item: "Rice crackers", action: "add", quantity: 1 }, { item: "Baby Spinach", action: "remove" }] });
    expect(res).toMatchObject({ status: "success", output: [{ status: "added_allergen_info_unknown" }, { status: "used_up" }] });
    const pantry = await w.care.executeTool(margaret, "getPantry", {});
    expect(JSON.stringify(pantry)).not.toContain('"name":"Baby Spinach"');
  });
});

describe("meal support and caregiver help requests", () => {
  it("help requests need the user's own consent and an enabled route; caregivers can't consent for her", async () => {
    const w = await careWorld();
    const input = { need: "home_task" as const, summary: "Margaret would like help preparing meals a few evenings a week." };
    const first = await w.care.executeTool(margaret, "requestPhysicalAssistance", input);
    expect(first.status).toBe("approval_required");
    if (first.status !== "approval_required") return;
    await expect(w.runtime.resolveApproval(daughter, first.approval.id, "approve")).rejects.toThrow(/only the user/);
    const { result } = await w.runtime.resolveApproval(margaret, first.approval.id, "approve");
    expect(result).toMatchObject({ status: "success", output: { status: "route_disabled" } });
    expect(await w.runtime.get("guardian").listTasks(margaret)).toHaveLength(0);

    await w.runtime.setConsent(margaret, "care", "guardian", "physical_assistance_request", true);
    const second = await w.care.executeTool(margaret, "requestPhysicalAssistance", input);
    if (second.status !== "approval_required") throw new Error();
    const ok = await w.runtime.resolveApproval(margaret, second.approval.id, "approve");
    expect(ok.result).toMatchObject({ status: "success", output: { status: "sent" } });
    const tasks = await w.runtime.get("guardian").listTasks(margaret);
    expect(tasks[0]).toMatchObject({ agentId: "guardian", title: "Arrange in-person help", origin: "event" });
  });

  it("Guardian handles a repeated event (same originating action) only once", async () => {
    const w = await careWorld();
    await w.runtime.setConsent(margaret, "care", "guardian", "physical_assistance_request", true);
    const ctx = { ...margaret, correlationId: "cor_fixed" };
    const payload = { need: "home_task", summary: "Help with meals" };
    const a = await w.runtime.bus.publish("care", "guardian", "physical_assistance_request", payload, ctx);
    const b = await w.runtime.bus.publish("care", "guardian", "physical_assistance_request", payload, ctx);
    expect(a.resultTaskId).toBe(b.resultTaskId);
    expect(await w.runtime.get("guardian").listTasks(margaret)).toHaveLength(1);
  });

  it("Wellness → Care meal assistance creates one Care task per originating action", async () => {
    const w = await careWorld();
    await w.runtime.setConsent(margaret, "wellness", "care", "meal_assistance_request", true);
    const ctx = { ...margaret, correlationId: "cor_meal" };
    const payload = { difficulty: "preparing_meals", summary: "Says cooking is tiring lately" };
    const a = await w.runtime.bus.publish("wellness", "care", "meal_assistance_request", payload, ctx);
    const b = await w.runtime.bus.publish("wellness", "care", "meal_assistance_request", payload, ctx);
    expect(a.status).toBe("handled");
    expect(b.resultTaskId).toBe(a.resultTaskId);
    expect((await w.care.listTasks(margaret)).filter((t) => t.workflowId === "meal_support")).toHaveLength(1);
  });

  it("paid meal delivery needs approval and respects spending limits", async () => {
    const w = await careWorld();
    const windows = w.services().env.adapters.grocery.deliveryWindows(w.clock.now(), "America/Los_Angeles");
    const big = await w.care.executeTool(margaret, "bookMealDelivery", { meals: 21, pricePerMealCents: 1500, windowId: windows[2].id });
    if (big.status !== "approval_required") throw new Error();
    const r1 = await w.runtime.resolveApproval(margaret, big.approval.id, "approve");
    expect(r1.result).toMatchObject({ status: "error" });
    const ok = await w.care.executeTool(margaret, "bookMealDelivery", { meals: 3, pricePerMealCents: 1200, windowId: windows[2].id });
    if (ok.status !== "approval_required") throw new Error();
    const r2 = await w.runtime.resolveApproval(daughter, ok.approval.id, "approve");
    expect(r2.result).toMatchObject({ status: "success", output: { simulated: true, total: "$36.00" } });
  });
});
