import { newId } from "@/lib/ids";
import { AgentError, isAgentError, toErrorMessage } from "../../base/errors";
import { EVENT_TYPES } from "../../contracts";
import { resolveAdapter } from "../adapters";
import { catalogById } from "../data/catalog";
import { RECIPES, recipeById } from "../data/recipes";
import { checkSpending, fmt } from "../domain/grocery";
import { applyCookingCommand, expiringSoon, speakStep, suggestMeals, type CookingCommandInput, type CookingSession, type PantryItem } from "../domain/meals";
import { localDateOf } from "../domain/time";
import { NS, type HelpRequestRecord, type MealPlanRecord, type OrderRecord } from "../repository";
import { MemoryService } from "./memoryService";
import type { CareEnv } from "./env";

export type PantryChange = {
  item: string;
  action: "add" | "remove" | "set";
  quantity?: number;
  unit?: string;
  expiresOn?: string;
  productId?: string;
};

export class MealService {
  constructor(private readonly env: CareEnv) {}

  private get repo() {
    return this.env.repo;
  }
  private async today(userId: string) {
    return localDateOf(this.env.now(), (await this.repo.profile(userId))?.timeZone ?? "UTC");
  }
  private voice() {
    return resolveAdapter(this.env.adapters.voice, this.env.integrationMode);
  }

  async pantry(userId: string) {
    const items = (await this.repo.pantry(userId)).filter((p) => p.quantity > 0);
    return { items, expiringSoon: expiringSoon(items, await this.today(userId)) };
  }

  /**
   * User-reported pantry changes. A new item with no catalog link has unknown allergen data, so the
   * meal planner won't use it in allergy-sensitive suggestions until it's linked to a product.
   */
  async updatePantry(userId: string, changes: PantryChange[]) {
    const items = await this.repo.pantry(userId);
    const now = this.env.now();
    const results: Array<{ item: string; quantity: number; status: string }> = [];
    for (const c of changes) {
      const name = c.item.trim().slice(0, 100);
      const existing = items.find((p) => p.name.toLowerCase() === name.toLowerCase()) ??
        items.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));
      if (c.action === "remove") {
        if (!existing) {
          results.push({ item: name, quantity: 0, status: "not_found" });
          continue;
        }
        const qty = c.quantity === undefined ? 0 : Math.max(0, existing.quantity - c.quantity);
        const next = { ...existing, quantity: qty, updatedAt: now };
        await this.repo.savePantryItem(userId, next);
        results.push({ item: existing.name, quantity: qty, status: qty === 0 ? "used_up" : "updated" });
        continue;
      }
      if (c.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(c.expiresOn)) throw new AgentError("VALIDATION_FAILED", "expiresOn must be YYYY-MM-DD");
      if (existing) {
        const qty = c.action === "set" ? c.quantity ?? existing.quantity : existing.quantity + (c.quantity ?? 1);
        const next = { ...existing, quantity: qty, expiresOn: c.expiresOn ?? existing.expiresOn, updatedAt: now };
        await this.repo.savePantryItem(userId, next);
        results.push({ item: existing.name, quantity: qty, status: "updated" });
      } else {
        const product = c.productId ? catalogById(c.productId) : undefined;
        const item: PantryItem = {
          id: newId("pantry"),
          name: product?.name ?? name,
          quantity: c.quantity ?? 1,
          unit: c.unit ?? "item",
          expiresOn: c.expiresOn ?? null,
          ingredients: product?.ingredients ?? null,
          allergens: product?.allergens ?? null,
          allergenInfo: product?.allergenInfo ?? "missing",
          tags: product?.tags ?? [],
          productId: product?.id,
          updatedAt: now,
          demo: false,
        };
        await this.repo.savePantryItem(userId, item);
        items.push(item);
        results.push({ item: item.name, quantity: item.quantity, status: product ? "added" : "added_allergen_info_unknown" });
      }
    }
    await this.env.audit(userId, "tool_result", "Pantry updated", { changes: changes.length });
    return results;
  }

  async suggest(userId: string, opts: { mealType?: "breakfast" | "lunch" | "dinner"; count?: number; maxMinutes?: number }) {
    const prefs = (await this.repo.preferences(userId)) ?? (await new MemoryService(this.env).ensurePreferences(userId));
    const today = await this.today(userId);
    const pantry = (await this.repo.pantry(userId)).filter((p) => p.quantity > 0);
    const result = suggestMeals(RECIPES, pantry, prefs.safety, today, { mealType: opts.mealType ?? "dinner", count: opts.count ?? 3, maxMinutes: opts.maxMinutes });
    const plan: MealPlanRecord = { id: newId("plan"), date: today, mealType: opts.mealType ?? "dinner", ideas: result.ideas, excluded: result.excluded, createdAt: this.env.now() };
    await this.repo.put(userId, NS.cooking, "latestPlan", plan, `Meal ideas for ${today}: ${result.ideas.map((i) => i.name).join(", ")}`);
    return { planId: plan.id, ...result };
  }

  async startCooking(userId: string, recipeId: string) {
    const recipe = recipeById(recipeId);
    if (!recipe) throw new AgentError("NOT_FOUND", "recipe not found");
    // Never walk through a recipe the safety filter would exclude.
    const prefs = await this.repo.preferences(userId);
    if (prefs) {
      const pantry = (await this.repo.pantry(userId)).filter((p) => p.quantity > 0);
      const check = suggestMeals([recipe], pantry, prefs.safety, await this.today(userId), { count: 1 });
      if (check.excluded.length) throw new AgentError("VALIDATION_FAILED", `this recipe doesn't pass your allergy/diet filters: ${check.excluded[0].reasons.join("; ")}`);
    }
    const now = this.env.now();
    const session: CookingSession = {
      id: newId("cook"),
      recipeId,
      recipeName: recipe.name,
      stepIndex: 0,
      totalSteps: recipe.steps.length,
      pace: "normal",
      simplified: false,
      status: "active",
      startedAt: now,
      updatedAt: now,
    };
    await this.repo.saveCooking(userId, session);
    const intro = `Let's make ${recipe.name}. I'll go one step at a time.`;
    const say = `${intro}\n${speakStep(session, recipe)}`;
    await this.voice().say(userId, say, "cooking_step", session.id);
    return { sessionId: session.id, say, step: 1, totalSteps: recipe.steps.length };
  }

  async cookingCommand(userId: string, command: CookingCommandInput) {
    const session = await this.repo.cooking(userId);
    if (!session || session.status !== "active") throw new AgentError("VALIDATION_FAILED", "no recipe in progress; start one first");
    const recipe = recipeById(session.recipeId)!;
    const res = applyCookingCommand(session, recipe, command, this.env.now());
    await this.repo.saveCooking(userId, res.session);
    await this.voice().say(userId, res.say, "cooking_step", session.id);
    return { say: res.say, step: res.session.stepIndex + 1, totalSteps: res.session.totalSteps, status: res.session.status };
  }

  /** Options offered when cooking is getting hard. Nothing is sent or booked here. */
  mealSupportOptions() {
    return {
      message:
        "I'm sorry cooking is getting harder. Here are some things I can do — you choose. Nothing is sent without your OK.",
      options: [
        { id: "ask_caregiver", label: "Ask your caregiver to help with meals", needs: "your consent (an approval)" },
        { id: "simple_recipes", label: "Show 15-minute recipes with fewer steps", needs: "nothing" },
        { id: "meal_delivery", label: "Prepare a meal-delivery booking (sandbox)", needs: "approval before anything is booked" },
      ],
    };
  }

  /**
   * Consent-gated by the tool's approval: only runs after the user approved sharing. Routes to Guardian
   * through the declared physical_assistance_request event; the bus enforces schema + enabled route.
   */
  async sendHelpRequest(userId: string, input: { need: HelpRequestRecord["need"]; summary: string; neededBy?: number }) {
    const now = this.env.now();
    const profile = await this.repo.profile(userId);
    const record: HelpRequestRecord = { id: newId("help"), need: input.need, summary: input.summary, status: "sent", createdAt: now, updatedAt: now, demo: profile?.isDemo ?? false };
    try {
      const evt = await this.env.emit("guardian", EVENT_TYPES.physicalAssistance, {
        need: input.need,
        summary: input.summary,
        ...(input.neededBy ? { neededBy: input.neededBy } : {}),
      });
      record.eventId = evt.id;
      record.status = evt.status === "failed" ? "failed" : "sent";
    } catch (err) {
      record.status = isAgentError(err) && err.code === "CONSENT_REQUIRED" ? "route_disabled" : "failed";
      await this.repo.put(userId, NS.helpRequests, record.id, record, `Help request (${record.status})`);
      await this.env.audit(userId, "event", "Help request not sent", { helpId: record.id, reason: toErrorMessage(err) }, "warn");
      return {
        helpRequestId: record.id,
        status: record.status,
        message:
          record.status === "route_disabled"
            ? "I couldn't send it because sharing help requests with Guardian is turned off. You can turn it on in Profile."
            : "Sorry, the help request couldn't be sent.",
      };
    }
    await this.repo.put(userId, NS.helpRequests, record.id, record, `Help request (${record.status})`);
    await this.env.audit(userId, "event", "Help request routed to Guardian", { helpId: record.id, eventId: record.eventId });
    return { helpRequestId: record.id, status: record.status, eventId: record.eventId, message: "I've passed your request to Guardian, who coordinates help from your caregiver." };
  }

  async helpRequests(userId: string) {
    return this.repo.list<HelpRequestRecord>(userId, NS.helpRequests);
  }

  /** Approval-gated by the tool. Sandbox booking only; counts toward the weekly spending limit. */
  async bookMealDelivery(userId: string, input: { meals: number; pricePerMealCents: number; windowId: string }) {
    const prefs = (await this.repo.preferences(userId)) ?? (await new MemoryService(this.env).ensurePreferences(userId));
    const tz = (await this.repo.profile(userId))?.timeZone ?? "UTC";
    const window = this.env.adapters.grocery.deliveryWindows(this.env.now(), tz).find((w) => w.id === input.windowId);
    if (!window) throw new AgentError("VALIDATION_FAILED", "unknown delivery window");
    const total = input.meals * input.pricePerMealCents;
    const orders = (await this.repo.orders(userId)).map((o) => ({ placedAt: o.placedAt, totalCents: o.totalCents, status: o.status }));
    const spend = checkSpending(total, orders, this.env.now(), prefs.limits);
    if (!spend.ok) throw new AgentError("VALIDATION_FAILED", spend.violations.join("; "));
    const adapter = resolveAdapter(this.env.adapters.mealDelivery, this.env.integrationMode);
    const res = await adapter.book(userId, { idempotencyKey: `${input.windowId}:${input.meals}:${input.pricePerMealCents}`, meals: input.meals, window, totalCents: total });
    if (!res.duplicate) {
      const now = this.env.now();
      const order: OrderRecord = {
        id: newId("order"),
        cartId: "meal_delivery",
        cartHash: res.bookingId,
        lines: [{ productId: "meal_delivery", name: `Meal delivery (${input.meals} meals)`, quantity: input.meals, unitPriceCents: input.pricePerMealCents }],
        totalCents: total,
        deliveryWindow: window,
        status: "placed",
        statusHistory: [{ at: now, status: "placed" }],
        placedAt: now,
        providerOrderId: res.bookingId,
        simulated: true,
        demo: prefs.demo,
      };
      await this.repo.saveOrder(userId, order);
    }
    return { bookingId: res.bookingId, total: fmt(total), window: window.label, simulated: true, duplicate: res.duplicate, note: "Sandbox booking — nothing was ordered or charged." };
  }
}
