import type { PastOrder, ShoppingProfile, UsualItem } from "./types";

/**
 * Demo shopping history for the person. "Usual groceries" is derived from this
 * history (items bought in most past orders), not hardcoded, so the cart reflects
 * what she actually buys.
 */
export function demoOrderHistory(nowMs: number = Date.now()): PastOrder[] {
  const week = 7 * 24 * 60 * 60 * 1000;
  return [
    { placedAt: nowMs - 1 * week, items: ["milk", "bread", "eggs", "bananas", "oats", "soup", "yogurt"], total: 31.4 },
    { placedAt: nowMs - 2 * week, items: ["milk", "bread", "eggs", "bananas", "soup", "yogurt"], total: 27.9 },
    { placedAt: nowMs - 3 * week, items: ["milk", "bread", "eggs", "bananas", "oats", "soup"], total: 26.1 },
    { placedAt: nowMs - 4 * week, items: ["milk", "eggs", "bananas", "oats", "yogurt", "cookies"], total: 25.3 },
  ];
}

/** Per-item preferences learned over time (brand, price, dietary needs). */
const ITEM_PREFERENCES: Omit<UsualItem, "timesOrdered">[] = [
  { key: "milk", label: "2% milk, 1 gallon", query: "2% milk gallon", category: "dairy", quantity: 1, preferredBrand: "Clover", usualPrice: 5.49, allowSubstitution: true },
  { key: "bread", label: "Whole wheat bread", query: "whole wheat bread", category: "bakery", quantity: 1, preferredBrand: "Dave's Killer Bread", usualPrice: 5.99, allowSubstitution: true },
  { key: "eggs", label: "Large eggs, dozen", query: "large eggs dozen", category: "dairy", quantity: 1, preferredBrand: "Vital Farms", usualPrice: 6.49, allowSubstitution: true },
  { key: "bananas", label: "Bananas, bunch", query: "bananas", category: "produce", quantity: 1, usualPrice: 1.89, allowSubstitution: true },
  { key: "oats", label: "Old-fashioned oats", query: "old fashioned rolled oats", category: "pantry", quantity: 1, preferredBrand: "Quaker", usualPrice: 4.79, allowSubstitution: true },
  { key: "soup", label: "Low-sodium vegetable soup", query: "low sodium vegetable soup", category: "pantry", quantity: 2, preferredBrand: "Pacific Foods", usualPrice: 3.99, allowSubstitution: true, requiredTags: ["low-sodium"] },
  { key: "yogurt", label: "Plain Greek yogurt", query: "plain greek yogurt", category: "dairy", quantity: 1, preferredBrand: "Fage", usualPrice: 5.29, allowSubstitution: false },
  { key: "cookies", label: "Shortbread cookies", query: "shortbread cookies", category: "snacks", quantity: 1, usualPrice: 3.99, allowSubstitution: true },
];

/**
 * Usual items = anything bought in at least half of recent orders. Pure, so the
 * "usual" list is explainable and testable.
 */
export function deriveUsualItems(history: PastOrder[], prefs = ITEM_PREFERENCES): UsualItem[] {
  if (!history.length) return [];
  const counts = new Map<string, number>();
  for (const o of history) for (const k of new Set(o.items)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const threshold = Math.ceil(history.length / 2);
  return prefs
    .filter((p) => (counts.get(p.key) ?? 0) >= threshold)
    .map((p) => ({ ...p, timesOrdered: counts.get(p.key) ?? 0 }));
}

export function demoShoppingProfile(userId: string, displayName = "Margaret", nowMs?: number): ShoppingProfile {
  return {
    userId,
    displayName,
    usualItems: deriveUsualItems(demoOrderHistory(nowMs)),
    avoidTags: ["high-sodium"],
    dislikedTerms: ["skim", "spicy", "sugar-free"],
    maxSubstitutionIncrease: 0.3,
    spendingLimit: 75,
    paymentMethod: { network: "visa", last4: "4242", label: "Visa ending 4242 (test card)", tokenRef: "sandbox_visa_token_4242" },
    deliveryAddressLabel: "Home",
  };
}
