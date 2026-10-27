/**
 * Pantry, meal ideas and step-by-step cooking. Meal ideas use the same allergy/diet gate as groceries
 * (assessProduct) on every ingredient; anything with unknown allergen data is left out. No health
 * claims, calorie targets or medication-related diet advice are produced here.
 */
import { assessProduct, type AllergenInfo, type SafetyProfile } from "./grocery";
import { addLocalDays } from "./time";

export interface PantryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  /** YYYY-MM-DD, or null when unknown. */
  expiresOn: string | null;
  /** Allergen data carried over from the product (null = unknown). */
  ingredients: string[] | null;
  allergens: { contains: string[]; mayContain: string[] } | null;
  allergenInfo: AllergenInfo;
  tags: string[];
  productId?: string;
  updatedAt: number;
  demo: boolean;
}

export function expiringSoon(pantry: PantryItem[], today: string, withinDays = 3) {
  const limit = addLocalDays(today, withinDays);
  return pantry
    .filter((p) => p.quantity > 0 && p.expiresOn !== null && p.expiresOn <= limit)
    .map((p) => ({ ...p, expired: p.expiresOn! < today }))
    .sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!));
}

export interface RecipeIngredient {
  /** Matches a pantry item whose name contains any of these keywords. */
  match: string[];
  label: string;
  optional?: boolean;
  /** Allergen data for when the ingredient isn't from the pantry (a staple). */
  staple?: { ingredients: string[]; allergens: { contains: string[]; mayContain: string[] } };
}

export interface RecipeStep {
  text: string;
  simple: string;
}

export interface Recipe {
  id: string;
  name: string;
  mealType: "breakfast" | "lunch" | "dinner";
  minutes: number;
  tags: string[];
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
}

export interface MealIdea {
  recipeId: string;
  name: string;
  minutes: number;
  uses: string[];
  usesExpiring: string[];
  missing: string[];
  excludedReason?: undefined;
}

export interface MealSuggestionResult {
  ideas: MealIdea[];
  excluded: Array<{ recipeId: string; name: string; reasons: string[] }>;
  note: string;
}

function findPantry(pantry: PantryItem[], ing: RecipeIngredient) {
  return pantry.find((p) => p.quantity > 0 && ing.match.some((m) => p.name.toLowerCase().includes(m)));
}

/**
 * Up to `count` meal ideas of a type, ranked by: uses items expiring soon, fewest missing ingredients,
 * preference tags, shorter time. Every used pantry item and staple passes the safety gate; a recipe
 * whose required ingredient has unknown allergen data is excluded rather than guessed.
 */
export function suggestMeals(
  recipes: Recipe[],
  pantry: PantryItem[],
  profile: SafetyProfile,
  today: string,
  opts: { mealType?: Recipe["mealType"]; count?: number; maxMinutes?: number } = {},
): MealSuggestionResult {
  const expiring = new Set(expiringSoon(pantry, today).filter((p) => !p.expired).map((p) => p.id));
  const excluded: MealSuggestionResult["excluded"] = [];
  const ideas: Array<MealIdea & { score: number }> = [];
  for (const r of recipes) {
    if (opts.mealType && r.mealType !== opts.mealType) continue;
    if (opts.maxMinutes && r.minutes > opts.maxMinutes) continue;
    const reasons: string[] = [];
    const uses: string[] = [];
    const usesExpiring: string[] = [];
    const missing: string[] = [];
    for (const ing of r.ingredients) {
      const item = findPantry(pantry, ing);
      if (item) {
        if (item.expiresOn && item.expiresOn < today) {
          if (!ing.optional) missing.push(ing.label);
          continue;
        }
        const verdict = assessProduct({ ...item }, profile);
        if (!verdict.safe) {
          if (ing.optional) continue;
          reasons.push(`${item.name}: ${verdict.reasons.join(", ")}`);
          continue;
        }
        uses.push(item.name);
        if (expiring.has(item.id)) usesExpiring.push(item.name);
      } else if (ing.staple) {
        const verdict = assessProduct(
          { name: ing.label, ingredients: ing.staple.ingredients, allergens: ing.staple.allergens, allergenInfo: "complete", tags: [] },
          profile,
        );
        if (!verdict.safe) {
          if (!ing.optional) reasons.push(`${ing.label}: ${verdict.reasons.join(", ")}`);
        } else if (!ing.optional) {
          missing.push(ing.label);
        }
      } else if (!ing.optional) {
        missing.push(ing.label);
      }
    }
    if (reasons.length) {
      excluded.push({ recipeId: r.id, name: r.name, reasons });
      continue;
    }
    const prefHits = profile.preferredTags.filter((t) => r.tags.includes(t)).length;
    const score = usesExpiring.length * 20 - missing.length * 8 + prefHits * 5 - r.minutes / 10;
    ideas.push({ recipeId: r.id, name: r.name, minutes: r.minutes, uses, usesExpiring, missing, score });
  }
  ideas.sort((a, b) => b.score - a.score);
  return {
    ideas: ideas.slice(0, opts.count ?? 3).map(({ score: _s, ...i }) => i),
    excluded,
    note: "Ideas use what's in your pantry and your saved preferences. They are everyday meal ideas, not medical or diet advice.",
  };
}

// ── Cooking session ────────────────────────────────────────────────────────

export interface CookingSession {
  id: string;
  recipeId: string;
  recipeName: string;
  stepIndex: number;
  totalSteps: number;
  pace: "normal" | "slow";
  simplified: boolean;
  status: "active" | "finished" | "stopped";
  startedAt: number;
  updatedAt: number;
}

export type CookingCommandInput = "start" | "next" | "repeat" | "slower" | "simpler" | "back" | "stop";

/** Applies one voice command and returns the single step to speak. One step at a time, by design. */
export function applyCookingCommand(
  session: CookingSession,
  recipe: Recipe,
  command: CookingCommandInput,
  now: number,
): { session: CookingSession; say: string } {
  let s: CookingSession = { ...session, updatedAt: now };
  switch (command) {
    case "start":
    case "repeat":
      break;
    case "next":
      if (s.stepIndex >= recipe.steps.length - 1) {
        s = { ...s, status: "finished" };
        return { session: s, say: `That was the last step. ${recipe.name} is done. Enjoy your meal!` };
      }
      s = { ...s, stepIndex: s.stepIndex + 1 };
      break;
    case "back":
      s = { ...s, stepIndex: Math.max(0, s.stepIndex - 1) };
      break;
    case "slower":
      s = { ...s, pace: "slow" };
      break;
    case "simpler":
      s = { ...s, simplified: true };
      break;
    case "stop":
      s = { ...s, status: "stopped" };
      return { session: s, say: "Okay, I've paused the recipe. Say “start cooking” when you want to pick it up again." };
  }
  return { session: s, say: speakStep(s, recipe) };
}

export function speakStep(s: CookingSession, recipe: Recipe): string {
  const step = recipe.steps[s.stepIndex];
  const body = s.simplified ? step.simple : step.text;
  const head = `Step ${s.stepIndex + 1} of ${recipe.steps.length}.`;
  if (s.pace === "slow") {
    // Slower delivery: one short sentence per line, so a TTS engine pauses between them.
    const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
    return [head, ...sentences, "Take your time. Say “next” when you're ready."].join("\n");
  }
  return `${head} ${body} Say “next” when you're ready, or “repeat” to hear it again.`;
}
