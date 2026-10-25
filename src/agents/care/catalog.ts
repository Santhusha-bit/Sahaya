/** Tiny stubbed product catalog so searchProducts and the meal planner return real, priced results. */
export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  keywords: string[];
}

export const CATALOG: CatalogProduct[] = [
  { id: "p_milk", name: "2% Milk, 1 gal", price: 3.79, keywords: ["milk", "dairy"] },
  { id: "p_bread", name: "Whole Wheat Bread", price: 2.99, keywords: ["bread", "wheat", "toast"] },
  { id: "p_eggs", name: "Large Eggs, dozen", price: 4.29, keywords: ["egg", "eggs"] },
  { id: "p_bananas", name: "Bananas, bunch", price: 1.89, keywords: ["banana", "fruit"] },
  { id: "p_oats", name: "Rolled Oats, 18oz", price: 3.49, keywords: ["oats", "oatmeal", "breakfast"] },
  { id: "p_chicken", name: "Chicken Breast, 1 lb", price: 5.99, keywords: ["chicken", "meat", "protein"] },
  { id: "p_rice", name: "Brown Rice, 2 lb", price: 2.69, keywords: ["rice", "grain"] },
  { id: "p_soup", name: "Low-Sodium Veg Soup", price: 2.19, keywords: ["soup", "canned", "vegetable"] },
  { id: "p_yogurt", name: "Greek Yogurt, 4-pack", price: 4.49, keywords: ["yogurt", "dairy", "protein"] },
  { id: "p_apples", name: "Apples, 3 lb bag", price: 4.99, keywords: ["apple", "fruit"] },
  { id: "p_spinach", name: "Baby Spinach, 5oz", price: 3.29, keywords: ["spinach", "greens"] },
  { id: "p_broccoli", name: "Broccoli Crowns, 1 lb", price: 2.49, keywords: ["broccoli"] },
  { id: "p_salmon", name: "Salmon Fillet, 12oz", price: 8.99, keywords: ["salmon", "fish"] },
  { id: "p_sweet_potato", name: "Sweet Potatoes, 2 lb", price: 2.99, keywords: ["sweet potato"] },
  { id: "p_green_beans", name: "Green Beans, 12oz", price: 2.79, keywords: ["green beans", "beans"] },
  { id: "p_lentils", name: "Dry Lentils, 1 lb", price: 1.99, keywords: ["lentil", "lentils"] },
  { id: "p_carrots", name: "Carrots, 2 lb", price: 1.69, keywords: ["carrot", "carrots"] },
  { id: "p_celery", name: "Celery Hearts", price: 2.49, keywords: ["celery"] },
  { id: "p_onion", name: "Yellow Onions, 3 lb", price: 2.99, keywords: ["onion", "onions"] },
  { id: "p_tomatoes_can", name: "No-Salt-Added Diced Tomatoes", price: 1.49, keywords: ["canned tomatoes", "diced tomatoes", "tomato sauce"] },
  { id: "p_broth", name: "Low-Sodium Vegetable Broth, 32oz", price: 2.89, keywords: ["broth", "stock"] },
  { id: "p_pasta", name: "Whole Wheat Penne, 1 lb", price: 1.99, keywords: ["pasta", "penne", "noodles"] },
  { id: "p_turkey", name: "Lean Ground Turkey, 1 lb", price: 5.49, keywords: ["ground turkey", "turkey"] },
  { id: "p_tortillas", name: "Whole Wheat Tortillas, 8ct", price: 2.99, keywords: ["tortilla", "tortillas"] },
  { id: "p_black_beans", name: "Low-Sodium Black Beans", price: 1.19, keywords: ["black beans"] },
  { id: "p_cheese", name: "Mild Cheddar, 8oz", price: 3.99, keywords: ["cheese", "cheddar"] },
  { id: "p_tofu", name: "Firm Tofu, 14oz", price: 2.49, keywords: ["tofu"] },
  { id: "p_soy_sauce", name: "Low-Sodium Soy Sauce", price: 3.19, keywords: ["soy sauce"] },
  { id: "p_potatoes", name: "Russet Potatoes, 5 lb", price: 3.99, keywords: ["potato", "potatoes"] },
  { id: "p_lemon", name: "Lemons, 2ct", price: 1.29, keywords: ["lemon"] },
  { id: "p_zucchini", name: "Zucchini, 1 lb", price: 1.99, keywords: ["zucchini"] },
  { id: "p_bell_pepper", name: "Bell Pepper", price: 1.29, keywords: ["bell pepper", "pepper"] },
];

/** Best catalog match for a free-text ingredient name, or null. */
export function findProduct(item: string): CatalogProduct | null {
  const q = item.toLowerCase().trim();
  return (
    CATALOG.find((p) => p.keywords.some((k) => k === q)) ??
    CATALOG.find((p) => p.keywords.some((k) => q.includes(k) || k.includes(q))) ??
    null
  );
}
