import { z } from "zod";
import type { AgentTool, MemoryRecord, ToolContext } from "../base/types";
import { getPantryVisionProvider } from "@/integrations/gemini";
import { takePantryImage } from "./pantryImages";
import {
  applyConfirmation,
  confirmedItems,
  uncertainItems,
  validatePantryScan,
  type PantryItem,
} from "./pantryPolicy";
import { planDinner, type FoodPreferences } from "./mealPlanner";

/**
 * Care's pantry-photo -> dinner workflow:
 *   1. scanPantryPhoto: Gemini proposes ingredients; pantryPolicy validates them.
 *   2. confirmPantryItems: the person confirms or rejects the uncertain ones.
 *   3. planDinnerFromPantry: the deterministic planner combines CONFIRMED items
 *      with food preferences, proposes a dinner and drafts a list of what is
 *      missing. Nothing is ordered here; ordering keeps its own approval gate.
 */

const SCANS = "pantryScans";
const PREFS = "dietPreferences";

export const DEFAULT_FOOD_PREFERENCES: FoodPreferences = {
  lowSodium: true,
  softFoods: true,
  vegetarian: false,
  allergies: [],
  dislikes: ["spicy"],
  maxPrepMinutes: 40,
  servings: 1,
};

const preferencesSchema = z.object({
  vegetarian: z.boolean().optional(),
  lowSodium: z.boolean().optional(),
  softFoods: z.boolean().optional(),
  allergies: z.array(z.string().min(1).max(30)).max(12).optional(),
  dislikes: z.array(z.string().min(1).max(30)).max(12).optional(),
  maxPrepMinutes: z.number().int().min(5).max(180).optional(),
  servings: z.number().int().min(1).max(8).optional(),
});

/**
 * Shared memory is append-only for agents, so each save is a new row. Rows carry
 * a monotonic revision because two saves can land in the same millisecond.
 */
async function latestPreferenceRow(ctx: Pick<ToolContext, "memory">): Promise<MemoryRecord | null> {
  const rows = await ctx.memory.readShared(PREFS, { limit: 20 }).catch(() => [] as MemoryRecord[]);
  return rows.reduce<MemoryRecord | null>(
    (best, r) => (!best || Number(r.data.revision ?? 0) > Number(best.data.revision ?? 0) ? r : best),
    null,
  );
}

export async function readFoodPreferences(ctx: Pick<ToolContext, "memory">): Promise<FoodPreferences> {
  const row = await latestPreferenceRow(ctx);
  const parsed = preferencesSchema.safeParse(row?.data ?? {});
  return { ...DEFAULT_FOOD_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}

async function latestScan(ctx: Pick<ToolContext, "memory">, scanId?: string): Promise<MemoryRecord | null> {
  if (scanId) return ctx.memory.get(scanId);
  const rows = await ctx.memory.list(SCANS, { limit: 1 });
  return rows[0] ?? null;
}

function scanView(rec: MemoryRecord) {
  const items = (rec.data.items as PantryItem[]) ?? [];
  return {
    scanId: rec.id,
    status: rec.data.status as string,
    provenance: rec.data.provenance,
    confirmed: confirmedItems(items).map((i) => i.name),
    uncertain: uncertainItems(items).map((i) => ({ name: i.name, confidence: i.confidence, note: i.note })),
    rejectedByPerson: items.filter((i) => i.status === "rejected").map((i) => i.name),
    rejectedByPolicy: rec.data.rejectedByPolicy,
    items,
    plan: rec.data.plan ?? null,
  };
}

function askAbout(uncertain: PantryItem[]): string {
  const names = uncertain.map((i) => i.displayName.toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `I wasn't sure about ${list}. Do you have ${names.length > 1 ? "those" : "that"}?`;
}

/** Keep the long-lived pantry list (used by suggestMeals) in step with confirmed items. */
async function syncPantry(ctx: ToolContext, items: PantryItem[]): Promise<void> {
  const existing = new Set((await ctx.memory.list("pantry")).map((p) => String(p.data.item ?? "").toLowerCase()));
  for (const item of confirmedItems(items)) {
    if (!existing.has(item.name)) await ctx.memory.save("pantry", { item: item.name, source: "photo" }, { tags: ["pantry"] });
  }
}

export const pantryTools: AgentTool[] = [
  {
    name: "scanPantryPhoto",
    description:
      "Identify ingredients in an uploaded refrigerator/pantry photo using Gemini vision. Takes the imageId returned by the photo upload; you cannot create one yourself. Uncertain items must be confirmed with the person before planning.",
    inputSchema: z.object({ imageId: z.string().min(1) }),
    async execute(input, ctx) {
      const image = takePantryImage(ctx.userId, input.imageId);
      if (!image) {
        return { ok: false, summary: "I couldn't find that photo. Could you take it again?", error: "image_not_found" };
      }
      const provider = getPantryVisionProvider();
      let raw: unknown;
      try {
        raw = (await provider.identifyIngredients({ imageBase64: image.base64, mimeType: image.mimeType })).raw;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await ctx.audit.record({ actor: "care", action: "pantry.scan_failed", correlationId: ctx.correlationId, detail: { provider: provider.name, reason: reason.slice(0, 200) } });
        return { ok: false, summary: "I had trouble reading that photo just now. Could you try again, or tell me what you have?", error: "vision_failed" };
      }
      const { items, rejected } = validatePantryScan(raw);
      const uncertain = uncertainItems(items);
      const provenance = { provider: provider.name, model: provider.model, mode: provider.mode };
      const rec = await ctx.memory.save(
        SCANS,
        { status: uncertain.length ? "needs_confirmation" : "confirmed", items, rejectedByPolicy: rejected, provenance },
        { tags: ["pantry", "scan"] },
      );
      await ctx.audit.record({
        actor: "care",
        action: "pantry.scanned",
        correlationId: ctx.correlationId,
        detail: { scanId: rec.id, ...provenance, items: items.length, uncertain: uncertain.length, rejectedByPolicy: rejected.length },
      });
      if (!uncertain.length) await syncPantry(ctx, items);
      const sure = confirmedItems(items).map((i) => i.name);
      const summary = items.length
        ? `I can see ${sure.length ? sure.join(", ") : "a few things"}.${uncertain.length ? ` ${askAbout(uncertain)}` : " Shall I plan dinner?"}`
        : "I couldn't make out any food in that photo. Could you try again with more light, or tell me what you have?";
      return { ok: true, summary, data: scanView(rec) };
    },
  },
  {
    name: "getPantryScan",
    description: "Return the latest pantry photo scan: confirmed items, items still needing confirmation, and any dinner plan.",
    inputSchema: z.object({ scanId: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await latestScan(ctx, input.scanId);
      const preferences = await readFoodPreferences(ctx);
      if (!rec) {
        return {
          ok: true,
          summary: "No pantry photo yet. Take a photo of your fridge or pantry and I'll take a look.",
          data: { scan: null, preferences },
        };
      }
      const view = scanView(rec);
      const uncertain = uncertainItems(view.items);
      return {
        ok: true,
        summary: uncertain.length ? askAbout(uncertain) : `You have ${view.confirmed.length} confirmed item(s).`,
        data: { scan: view, preferences },
      };
    },
  },
  {
    name: "confirmPantryItems",
    description:
      "Record the person's answers about their pantry scan: which uncertain items they really have (confirm), which they don't (reject), and anything the camera missed (add).",
    inputSchema: z.object({
      scanId: z.string().optional(),
      confirm: z.array(z.string().min(1)).max(40).default([]),
      reject: z.array(z.string().min(1)).max(40).default([]),
      add: z.array(z.string().min(1)).max(20).default([]),
      confirmAllUncertain: z.boolean().default(false),
    }),
    async execute(input, ctx) {
      const rec = await latestScan(ctx, input.scanId);
      if (!rec) return { ok: false, summary: "There's no pantry photo to confirm yet.", error: "no_scan" };
      const { items, ignored } = applyConfirmation((rec.data.items as PantryItem[]) ?? [], input);
      const uncertain = uncertainItems(items);
      const updated = await ctx.memory.update(rec.id, {
        items,
        status: uncertain.length ? "needs_confirmation" : "confirmed",
        plan: null,
      });
      await ctx.audit.record({
        actor: "care",
        action: "pantry.confirmed",
        correlationId: ctx.correlationId,
        detail: { scanId: rec.id, confirm: input.confirm, reject: input.reject, add: input.add, all: input.confirmAllUncertain, ignored },
      });
      if (!uncertain.length) await syncPantry(ctx, items);
      const summary = uncertain.length
        ? `Thanks. ${askAbout(uncertain)}`
        : `Thanks, I've got ${confirmedItems(items).length} item(s) confirmed. Ready to plan dinner.`;
      return { ok: true, summary, data: { ...scanView(updated ?? rec), ignored } };
    },
  },
  {
    name: "planDinnerFromPantry",
    description:
      "Propose a practical dinner from the CONFIRMED pantry items and the person's food preferences, and draft a grocery list of missing items. Refuses until uncertain items are confirmed. Does not order anything.",
    inputSchema: z.object({ scanId: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await latestScan(ctx, input.scanId);
      const prefs = await readFoodPreferences(ctx);
      let have: string[];
      if (rec) {
        const items = (rec.data.items as PantryItem[]) ?? [];
        const uncertain = uncertainItems(items);
        // Code-enforced: uncertain items are never silently used or dropped.
        if (uncertain.length) {
          return {
            ok: false,
            summary: `Before I plan dinner, can you check something for me? ${askAbout(uncertain)}`,
            error: "needs_confirmation",
            data: scanView(rec),
          };
        }
        have = confirmedItems(items).map((i) => i.name);
      } else {
        have = (await ctx.memory.list("pantry")).map((p) => String(p.data.item ?? "")).filter(Boolean);
      }

      const plan = planDinner(have, prefs);
      if (!plan.dinner) {
        return { ok: false, summary: "I couldn't find a dinner that fits your preferences. Want to adjust them?", error: "no_recipe", data: { plan } };
      }
      let groceryListId: string | null = null;
      if (plan.missingItems.length) {
        const list = await ctx.memory.save(
          "groceryLists",
          {
            items: plan.missingItems.map((m) => m.item),
            lines: plan.missingItems,
            status: "draft",
            source: "pantry-plan",
            recipe: plan.dinner.name,
          },
          { tags: ["grocery"] },
        );
        groceryListId = list.id;
      }
      if (rec) await ctx.memory.update(rec.id, { plan: { ...plan, groceryListId, preferences: prefs, at: Date.now() } });
      await ctx.audit.record({
        actor: "care",
        action: "pantry.planned",
        correlationId: ctx.correlationId,
        detail: { scanId: rec?.id ?? null, recipe: plan.dinner.id, missing: plan.missingItems.map((m) => m.item), excluded: plan.excluded.length },
      });

      const required = plan.missingItems.filter((m) => !m.optional).map((m) => m.item);
      const optional = plan.missingItems.filter((m) => m.optional).map((m) => m.item);
      const shopping = required.length
        ? ` You'd need ${required.join(", ")}${optional.length ? ` (and optionally ${optional.join(", ")})` : ""}; I've started a grocery list.`
        : optional.length
          ? ` You have everything you need. If you like, add ${optional.join(", ")}; I've put those on a grocery list.`
          : " You have everything you need.";
      return {
        ok: true,
        summary: `How about ${plan.dinner.name.toLowerCase()}? About ${plan.dinner.prepMinutes} minutes.${shopping}`,
        data: { plan, groceryListId, preferences: prefs },
      };
    },
  },
  {
    name: "updateFoodPreferences",
    description: "Update the person's food preferences used for meal planning (allergies, dislikes, vegetarian, low sodium, soft foods, prep time, servings).",
    inputSchema: preferencesSchema,
    async execute(input, ctx) {
      const current = await readFoodPreferences(ctx);
      const revision = Number((await latestPreferenceRow(ctx))?.data.revision ?? 0) + 1;
      const next = { ...current, ...input };
      await ctx.memory.writeShared(PREFS, { ...next, revision });
      await ctx.audit.record({ actor: "care", action: "pantry.preferences", correlationId: ctx.correlationId, detail: { ...input } });
      return { ok: true, summary: "Got it, I've updated your food preferences.", data: { preferences: next } };
    },
  },
];
