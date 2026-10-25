import { findProduct } from "./catalog";

/**
 * PURE deterministic meal planner (no I/O, no model calls).
 *
 * Combines the person's CONFIRMED ingredients with their food preferences and
 * proposes a practical dinner plus a list of what is missing. Safety-relevant
 * preferences (allergies, vegetarian) are hard filters enforced here in code,
 * never left to a prompt. Wording is practical cooking guidance only: no
 * nutrition claims, diagnoses or medication advice.
 */

export interface FoodPreferences {
  vegetarian?: boolean;
  lowSodium?: boolean;
  softFoods?: boolean;
  allergies?: string[];
  dislikes?: string[];
  maxPrepMinutes?: number;
  servings?: number;
}

type Allergen = "egg" | "dairy" | "gluten" | "fish" | "shellfish" | "soy" | "peanut" | "tree_nut";

interface RecipeIngredient {
  /** Any of these names satisfies the ingredient. The first is shown on lists. */
  any: string[];
  optional?: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  prepMinutes: number;
  servings: number;
  ingredients: RecipeIngredient[];
  allergens: Allergen[];
  containsMeat: boolean;
  spicy?: boolean;
  soft?: boolean;
  lowSodiumFriendly?: boolean;
  steps: string[];
}

/** Assumed on hand in any kitchen; never put on a shopping list. */
export const ASSUMED_STAPLES = ["water", "cooking oil", "black pepper", "dried herbs"];

export const RECIPES: Recipe[] = [
  {
    id: "spinach_cheese_omelette",
    name: "Spinach and cheese omelette",
    prepMinutes: 15,
    servings: 1,
    ingredients: [{ any: ["eggs"] }, { any: ["spinach"] }, { any: ["cheese"], optional: true }, { any: ["onion"], optional: true }],
    allergens: ["egg", "dairy"],
    containsMeat: false,
    soft: true,
    lowSodiumFriendly: true,
    steps: [
      "Whisk 2 or 3 eggs with a splash of milk if you have it.",
      "Wilt a handful of spinach in a non-stick pan with a little oil.",
      "Pour in the eggs, cook gently, add a little cheese, then fold.",
    ],
  },
  {
    id: "chicken_rice_broccoli",
    name: "Lemon chicken with brown rice and broccoli",
    prepMinutes: 35,
    servings: 2,
    ingredients: [{ any: ["chicken"] }, { any: ["rice"] }, { any: ["broccoli"] }, { any: ["lemon"], optional: true }, { any: ["onion"], optional: true }],
    allergens: [],
    containsMeat: true,
    lowSodiumFriendly: true,
    steps: [
      "Start the rice first (about 30 minutes for brown rice).",
      "Cook the chicken in a covered pan until no pink remains in the middle.",
      "Steam the broccoli for 5 minutes and finish everything with lemon instead of salt.",
    ],
  },
  {
    id: "chicken_vegetable_soup",
    name: "Gentle chicken and vegetable soup",
    prepMinutes: 40,
    servings: 3,
    ingredients: [
      { any: ["chicken"] },
      { any: ["carrot"] },
      { any: ["onion"] },
      { any: ["celery"], optional: true },
      { any: ["rice", "pasta", "noodles"], optional: true },
      { any: ["broth"], optional: true },
    ],
    allergens: [],
    containsMeat: true,
    soft: true,
    lowSodiumFriendly: true,
    steps: [
      "Soften chopped onion and carrot in a pot with a little oil.",
      "Add the chicken and water or low-sodium broth, and simmer 25 minutes.",
      "Shred the chicken, add a little rice if you like, and season with herbs.",
    ],
  },
  {
    id: "salmon_sweet_potato",
    name: "Baked salmon with sweet potato and green beans",
    prepMinutes: 30,
    servings: 2,
    ingredients: [{ any: ["salmon"] }, { any: ["sweet potato"] }, { any: ["green beans"] }, { any: ["lemon"], optional: true }],
    allergens: ["fish"],
    containsMeat: true,
    soft: true,
    lowSodiumFriendly: true,
    steps: [
      "Roast sweet potato chunks at 400F for 15 minutes.",
      "Add the salmon and green beans to the tray and roast 12 to 15 minutes more.",
      "Squeeze lemon over the top before serving.",
    ],
  },
  {
    id: "lentil_vegetable_soup",
    name: "Lentil and vegetable soup",
    prepMinutes: 40,
    servings: 4,
    ingredients: [
      { any: ["lentils"] },
      { any: ["carrot"] },
      { any: ["onion"] },
      { any: ["canned tomatoes", "diced tomatoes", "tomato sauce", "tomatoes"] },
      { any: ["spinach"], optional: true },
      { any: ["celery"], optional: true },
    ],
    allergens: [],
    containsMeat: false,
    soft: true,
    lowSodiumFriendly: true,
    steps: [
      "Soften chopped onion and carrot in a pot.",
      "Add rinsed lentils, tomatoes and 4 cups of water, and simmer 30 minutes.",
      "Stir in spinach at the end until it wilts.",
    ],
  },
  {
    id: "turkey_veggie_pasta",
    name: "Turkey and vegetable pasta",
    prepMinutes: 25,
    servings: 2,
    ingredients: [
      { any: ["pasta", "penne", "noodles"] },
      { any: ["ground turkey", "turkey"] },
      { any: ["canned tomatoes", "diced tomatoes", "tomato sauce", "tomatoes"] },
      { any: ["zucchini", "spinach"], optional: true },
    ],
    allergens: ["gluten"],
    containsMeat: true,
    lowSodiumFriendly: true,
    steps: [
      "Boil the pasta.",
      "Brown the turkey, then add tomatoes and any vegetables and simmer 10 minutes.",
      "Toss with the pasta.",
    ],
  },
  {
    id: "bean_cheese_quesadilla",
    name: "Black bean and cheese quesadilla",
    prepMinutes: 15,
    servings: 1,
    ingredients: [{ any: ["tortillas"] }, { any: ["black beans"] }, { any: ["cheese"] }, { any: ["bell pepper", "spinach"], optional: true }],
    allergens: ["gluten", "dairy"],
    containsMeat: false,
    steps: [
      "Mash a few spoonfuls of rinsed beans onto a tortilla and add cheese.",
      "Top with a second tortilla and warm in a dry pan, 2 to 3 minutes per side.",
    ],
  },
  {
    id: "tofu_stir_fry",
    name: "Tofu and vegetable stir-fry with rice",
    prepMinutes: 30,
    servings: 2,
    ingredients: [{ any: ["tofu"] }, { any: ["rice"] }, { any: ["broccoli", "bell pepper", "carrot"] }, { any: ["soy sauce"], optional: true }],
    allergens: ["soy"],
    containsMeat: false,
    lowSodiumFriendly: true,
    steps: [
      "Start the rice.",
      "Brown cubed tofu in a pan, then add the vegetables and cook until tender.",
      "Add a small splash of low-sodium soy sauce at the end.",
    ],
  },
  {
    id: "loaded_baked_potato",
    name: "Baked potato with broccoli and cheese",
    prepMinutes: 25,
    servings: 1,
    ingredients: [{ any: ["potatoes"] }, { any: ["broccoli"] }, { any: ["cheese"] }, { any: ["yogurt"], optional: true }],
    allergens: ["dairy"],
    containsMeat: false,
    soft: true,
    lowSodiumFriendly: true,
    steps: [
      "Microwave a pricked potato 8 to 10 minutes, turning once.",
      "Steam the broccoli, then split the potato and top with broccoli and cheese.",
    ],
  },
  {
    id: "eggs_on_toast",
    name: "Soft scrambled eggs on toast",
    prepMinutes: 10,
    servings: 1,
    ingredients: [{ any: ["eggs"] }, { any: ["bread"] }, { any: ["spinach"], optional: true }],
    allergens: ["egg", "gluten"],
    containsMeat: false,
    soft: true,
    lowSodiumFriendly: true,
    steps: ["Scramble 2 eggs slowly over low heat.", "Serve on toast with spinach on the side if you have it."],
  },
  {
    id: "beef_chili",
    name: "Spicy beef and bean chili",
    prepMinutes: 45,
    servings: 4,
    ingredients: [{ any: ["ground beef"] }, { any: ["kidney beans", "black beans"] }, { any: ["canned tomatoes", "diced tomatoes", "tomatoes"] }, { any: ["onion"] }],
    allergens: [],
    containsMeat: true,
    spicy: true,
    steps: ["Brown the beef and onion.", "Add beans, tomatoes and chili spices, and simmer 30 minutes."],
  },
];

/** "carrots" -> "carrot", "tomatoes" -> "tomato", "berries" -> "berry". */
function singular(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);
}

/** True when every word of the recipe ingredient appears in the pantry item name. */
export function ingredientMatches(wanted: string, have: string): boolean {
  const w = tokens(wanted);
  const h = tokens(have);
  if (!w.length) return false;
  // "potato" should not be satisfied by "sweet potato".
  if (h.includes("sweet") && !w.includes("sweet")) return false;
  return w.every((t) => h.includes(t));
}

const ALLERGY_MAP: Record<string, Allergen> = {
  egg: "egg", eggs: "egg",
  dairy: "dairy", milk: "dairy", lactose: "dairy", cheese: "dairy",
  gluten: "gluten", wheat: "gluten",
  fish: "fish", salmon: "fish",
  shellfish: "shellfish", shrimp: "shellfish",
  soy: "soy", tofu: "soy",
  peanut: "peanut", peanuts: "peanut",
  nut: "tree_nut", nuts: "tree_nut", "tree nuts": "tree_nut",
};

export interface PlannedRecipe {
  id: string;
  name: string;
  prepMinutes: number;
  servings: number;
  using: string[];
  missing: string[];
  missingOptional: string[];
  steps: string[];
  tips: string[];
  score: number;
}

export interface MissingItem {
  item: string;
  productId: string | null;
  productName: string | null;
  price: number | null;
  optional: boolean;
}

export interface MealPlan {
  dinner: PlannedRecipe | null;
  alternatives: PlannedRecipe[];
  missingItems: MissingItem[];
  excluded: { recipe: string; reason: string }[];
  assumedStaples: string[];
}

function exclusionReason(recipe: Recipe, prefs: FoodPreferences): string | null {
  const allNames = recipe.ingredients.flatMap((i) => i.any);
  for (const allergy of prefs.allergies ?? []) {
    const a = allergy.toLowerCase().trim();
    const mapped = ALLERGY_MAP[a];
    if (mapped && recipe.allergens.includes(mapped)) return `contains ${a} (allergy)`;
    if (allNames.some((n) => ingredientMatches(a, n) || ingredientMatches(n, a))) return `contains ${a} (allergy)`;
  }
  if (prefs.vegetarian && recipe.containsMeat) return "not vegetarian";
  for (const dislike of prefs.dislikes ?? []) {
    const d = dislike.toLowerCase().trim();
    if (d === "spicy" || d === "spicy food") {
      if (recipe.spicy) return "spicy";
      continue;
    }
    if (allNames.some((n) => ingredientMatches(d, n))) return `contains ${d} (dislike)`;
  }
  if (prefs.maxPrepMinutes && recipe.prepMinutes > prefs.maxPrepMinutes + 10) return `takes ${recipe.prepMinutes} min`;
  return null;
}

function planRecipe(recipe: Recipe, have: string[], prefs: FoodPreferences): PlannedRecipe {
  const using: string[] = [];
  const missing: string[] = [];
  const missingOptional: string[] = [];
  for (const ing of recipe.ingredients) {
    const hit = have.find((h) => ing.any.some((n) => ingredientMatches(n, h)));
    if (hit) using.push(hit);
    else if (ing.optional) missingOptional.push(ing.any[0]);
    else missing.push(ing.any[0]);
  }
  const required = recipe.ingredients.filter((i) => !i.optional).length;
  const haveRequired = required - missing.length;
  let score = (haveRequired / Math.max(1, required)) * 100 - missing.length * 12 + (using.length - haveRequired) * 3;
  if (prefs.lowSodium && recipe.lowSodiumFriendly) score += 4;
  if (prefs.softFoods && recipe.soft) score += 6;
  if (prefs.maxPrepMinutes && recipe.prepMinutes > prefs.maxPrepMinutes) score -= 8;

  const tips: string[] = [];
  if (prefs.lowSodium) tips.push("Season with lemon, pepper or herbs instead of salt, and choose low-sodium broth or canned goods.");
  if (prefs.softFoods && !recipe.soft) tips.push("Cook the vegetables a little longer so they are soft.");
  const servings = prefs.servings ?? 1;
  if (recipe.servings > servings) tips.push(`Makes about ${recipe.servings} servings; leftovers keep 3 days in the fridge.`);

  return {
    id: recipe.id,
    name: recipe.name,
    prepMinutes: recipe.prepMinutes,
    servings: recipe.servings,
    using,
    missing,
    missingOptional,
    steps: recipe.steps,
    tips,
    score: Math.round(score),
  };
}

/** Rank dinners using ONLY confirmed ingredients and the person's preferences. */
export function planDinner(confirmedIngredients: string[], prefs: FoodPreferences = {}): MealPlan {
  const have = confirmedIngredients.map((i) => i.toLowerCase().trim()).filter(Boolean);
  const excluded: MealPlan["excluded"] = [];
  const candidates: PlannedRecipe[] = [];
  for (const recipe of RECIPES) {
    const reason = exclusionReason(recipe, prefs);
    if (reason) {
      excluded.push({ recipe: recipe.name, reason });
      continue;
    }
    candidates.push(planRecipe(recipe, have, prefs));
  }
  candidates.sort((a, b) => b.score - a.score || a.prepMinutes - b.prepMinutes);
  const dinner = candidates[0] ?? null;
  const toItem = (item: string, optional: boolean): MissingItem => {
    const p = findProduct(item);
    return { item, productId: p?.id ?? null, productName: p?.name ?? null, price: p?.price ?? null, optional };
  };
  const missingItems = [
    ...(dinner?.missing ?? []).map((i) => toItem(i, false)),
    ...(dinner?.missingOptional ?? []).map((i) => toItem(i, true)),
  ];
  return { dinner, alternatives: candidates.slice(1, 3), missingItems, excluded, assumedStaples: ASSUMED_STAPLES };
}
