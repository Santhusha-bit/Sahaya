import type { Recipe } from "../domain/meals";

const staple = (ingredients: string[], contains: string[] = []) => ({ ingredients, allergens: { contains, mayContain: [] } });

/** Simple, fictional demo recipes. No health claims. */
export const RECIPES: Recipe[] = [
  {
    id: "r_spinach_omelette",
    name: "Spinach & Swiss Omelette",
    mealType: "dinner",
    minutes: 15,
    tags: ["low_sodium", "quick"],
    ingredients: [
      { match: ["egg"], label: "2 eggs" },
      { match: ["spinach"], label: "a handful of spinach" },
      { match: ["swiss"], label: "1 slice Swiss cheese", optional: true },
      { match: ["olive oil", "butter"], label: "a little oil or butter", staple: staple(["olive oil"]) },
    ],
    steps: [
      { text: "Crack 2 eggs into a bowl and beat them with a fork until smooth.", simple: "Crack 2 eggs into a bowl. Mix with a fork." },
      { text: "Warm a teaspoon of oil or butter in a small non-stick pan over medium-low heat.", simple: "Put a little oil in a pan. Turn the heat to low." },
      { text: "Add a handful of spinach and stir for about one minute until it wilts.", simple: "Add the spinach. Stir for one minute." },
      { text: "Pour in the eggs and let them set for 2 to 3 minutes without stirring.", simple: "Pour in the eggs. Wait 2 or 3 minutes." },
      { text: "Lay the Swiss slice on one half, fold the omelette over, and slide it onto a plate.", simple: "Fold it in half. Put it on a plate." },
      { text: "Turn off the stove before you sit down to eat.", simple: "Turn off the stove." },
    ],
  },
  {
    id: "r_salmon_potatoes",
    name: "Baked Salmon with Potatoes & Broccoli",
    mealType: "dinner",
    minutes: 35,
    tags: ["low_sodium"],
    ingredients: [
      { match: ["salmon"], label: "1 salmon fillet" },
      { match: ["potato"], label: "2 small potatoes" },
      { match: ["broccoli"], label: "broccoli" },
      { match: ["lemon"], label: "lemon", optional: true },
      { match: ["olive oil"], label: "olive oil", staple: staple(["olive oil"]) },
    ],
    steps: [
      { text: "Heat the oven to 400°F (200°C).", simple: "Turn the oven to 400." },
      { text: "Cut the potatoes into small cubes, toss with a spoon of olive oil, and roast on a tray for 15 minutes.", simple: "Cut the potatoes small. Add oil. Bake 15 minutes." },
      { text: "Add the salmon and broccoli to the tray with a little oil and a squeeze of lemon.", simple: "Put the salmon and broccoli on the tray." },
      { text: "Bake 12 to 15 minutes more, until the salmon flakes easily with a fork.", simple: "Bake about 15 more minutes." },
      { text: "Use oven mitts to take the tray out, and turn off the oven.", simple: "Use oven mitts. Turn off the oven." },
    ],
  },
  {
    id: "r_bean_tomato_soup",
    name: "Black Bean & Tomato Soup",
    mealType: "dinner",
    minutes: 25,
    tags: ["low_sodium", "vegan"],
    ingredients: [
      { match: ["black beans"], label: "1 can no-salt black beans" },
      { match: ["diced tomatoes", "tomato"], label: "1 can diced tomatoes" },
      { match: ["broth"], label: "2 cups low-sodium broth" },
      { match: ["onion"], label: "half an onion", optional: true },
    ],
    steps: [
      { text: "Chop half an onion and soften it in a pot with a little oil for 5 minutes.", simple: "Cook the chopped onion for 5 minutes." },
      { text: "Add the drained beans, the tomatoes and the broth.", simple: "Add the beans, tomatoes and broth." },
      { text: "Bring to a gentle simmer and cook for 15 minutes, stirring now and then.", simple: "Let it bubble gently for 15 minutes." },
      { text: "Turn off the heat and let it cool a few minutes before serving.", simple: "Turn off the stove. Let it cool a little." },
    ],
  },
  {
    id: "r_chicken_rice",
    name: "Chicken, Rice & Carrots",
    mealType: "dinner",
    minutes: 40,
    tags: ["low_sodium"],
    ingredients: [
      { match: ["chicken breast"], label: "1 chicken breast" },
      { match: ["rice"], label: "1/2 cup brown rice" },
      { match: ["carrot"], label: "2 carrots" },
      { match: ["broth"], label: "low-sodium broth", optional: true },
    ],
    steps: [
      { text: "Rinse half a cup of rice and simmer it in one cup of broth or water, covered, for 30 minutes.", simple: "Cook the rice in a covered pot for 30 minutes." },
      { text: "Slice the carrots and the chicken into thin strips.", simple: "Cut the carrots and chicken into strips." },
      { text: "Cook the chicken in a pan with a little oil for 6 to 8 minutes, until no pink remains.", simple: "Cook the chicken until it is not pink inside." },
      { text: "Add the carrots and cook 4 more minutes, then serve over the rice.", simple: "Add the carrots. Cook 4 minutes. Serve on the rice." },
      { text: "Turn off the stove and wash your hands after handling raw chicken.", simple: "Turn off the stove. Wash your hands." },
    ],
  },
  {
    id: "r_satay_noodles",
    name: "Peanut Satay Noodles",
    mealType: "dinner",
    minutes: 20,
    tags: [],
    ingredients: [
      { match: ["peanut butter"], label: "peanut butter", staple: staple(["peanuts", "salt"], ["peanut"]) },
      { match: ["pasta", "noodle"], label: "noodles" },
      { match: ["carrot"], label: "carrots", optional: true },
    ],
    steps: [
      { text: "Boil the noodles.", simple: "Boil the noodles." },
      { text: "Stir in the peanut sauce.", simple: "Add the sauce." },
    ],
  },
  {
    id: "r_cracker_plate",
    name: "Veggie Cracker Snack Plate",
    mealType: "dinner",
    minutes: 5,
    tags: ["quick"],
    ingredients: [
      { match: ["veggie crackers"], label: "veggie crackers" },
      { match: ["swiss", "turkey"], label: "cheese or turkey" },
    ],
    steps: [{ text: "Arrange everything on a plate.", simple: "Put it on a plate." }],
  },
  {
    id: "r_veg_pasta",
    name: "Whole Wheat Penne with Tomatoes & Spinach",
    mealType: "dinner",
    minutes: 20,
    tags: ["low_sodium", "vegan"],
    ingredients: [
      { match: ["penne", "pasta"], label: "whole wheat penne" },
      { match: ["diced tomatoes", "tomato"], label: "tomatoes" },
      { match: ["spinach"], label: "spinach", optional: true },
      { match: ["olive oil"], label: "olive oil", staple: staple(["olive oil"]) },
    ],
    steps: [
      { text: "Boil the penne in unsalted water for 10 to 11 minutes, then drain.", simple: "Boil the pasta about 10 minutes. Drain it." },
      { text: "Warm the tomatoes in a pan with a spoon of olive oil for 5 minutes.", simple: "Warm the tomatoes with a little oil." },
      { text: "Stir in the spinach until it wilts, then toss with the pasta.", simple: "Add the spinach. Mix with the pasta." },
      { text: "Turn off the stove before serving.", simple: "Turn off the stove." },
    ],
  },
];

export function recipeById(id: string) {
  return RECIPES.find((r) => r.id === id);
}
