/**
 * Deterministic grocery rules: allergy and diet safety, unit pricing, substitutions, cart totals and
 * spending limits. Claude can propose items; nothing reaches a cart without passing `assessProduct`.
 */

export type AllergenInfo = "complete" | "missing" | "ambiguous";

export interface Product {
  id: string;
  name: string;
  brand: string;
  category: string;
  /** Products in the same group are acceptable substitutes for each other. */
  substituteGroup: string;
  size: { amount: number; unit: "g" | "ml" | "each" };
  priceCents: number;
  /** Declared ingredients; null when the listing has none. */
  ingredients: string[] | null;
  /** Declared allergens ("contains") and precautionary ("may contain"). */
  allergens: { contains: string[]; mayContain: string[] } | null;
  /** How trustworthy the allergen data is. Anything but `complete` is treated as unknown. */
  allergenInfo: AllergenInfo;
  tags: string[];
  inStock: boolean;
  /** Free text from the catalog. UNTRUSTED: never used for decisions. */
  description: string;
  demo: true;
}

export interface SafetyProfile {
  /** Allergies (e.g. "peanut"). Any product that might contain one is excluded. */
  allergies: string[];
  /** Hard dietary restrictions supplied by the user/caregiver, as product tags that must be present. */
  requiredTags: string[];
  /** Preferences only affect ranking (e.g. "low_sodium"). */
  preferredTags: string[];
}

/** Synonyms used for ingredient-text scanning, as defence in depth beyond declared allergens. */
export const ALLERGEN_SYNONYMS: Record<string, string[]> = {
  peanut: ["peanut", "peanuts", "groundnut", "groundnuts", "arachis", "monkey nut", "goober"],
  tree_nut: ["almond", "cashew", "walnut", "pecan", "hazelnut", "pistachio", "macadamia", "brazil nut"],
  milk: ["milk", "whey", "casein", "butter", "cream", "cheese", "lactose"],
  egg: ["egg", "albumin", "mayonnaise"],
  wheat: ["wheat", "flour", "semolina", "spelt"],
  soy: ["soy", "soya", "tofu", "edamame"],
  fish: ["fish", "salmon", "tuna", "cod", "anchovy"],
  shellfish: ["shrimp", "prawn", "crab", "lobster"],
  sesame: ["sesame", "tahini"],
};

function canonicalAllergen(a: string) {
  const k = a.toLowerCase().trim().replace(/s$/, "").replace(/\s+/g, "_");
  return k === "peanut_butter" ? "peanut" : k;
}

function mentions(text: string, allergen: string): boolean {
  const words = ALLERGEN_SYNONYMS[allergen] ?? [allergen.replace(/_/g, " ")];
  const t = text.toLowerCase();
  return words.some((w) => new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}`).test(t));
}

export type SafetyVerdict = { safe: true } | { safe: false; reasons: string[] };

/**
 * The single allergy/diet gate for products, cart lines, substitutions and meal ingredients.
 * Unknown is unsafe: missing or ambiguous allergen data excludes the product whenever the profile
 * has any allergy. The (untrusted) description is never consulted to *include* a product.
 */
export function assessProduct(p: Pick<Product, "name" | "ingredients" | "allergens" | "allergenInfo" | "tags">, profile: SafetyProfile): SafetyVerdict {
  const reasons: string[] = [];
  const allergies = profile.allergies.map(canonicalAllergen);
  if (allergies.length) {
    if (p.allergenInfo !== "complete" || !p.allergens || !p.ingredients) {
      reasons.push(`allergen information is ${p.allergenInfo === "complete" ? "incomplete" : p.allergenInfo}`);
    } else {
      for (const a of allergies) {
        const declared = [...p.allergens.contains, ...p.allergens.mayContain].map(canonicalAllergen);
        if (declared.includes(a)) reasons.push(`declares ${a.replace(/_/g, " ")}`);
        else if (p.ingredients.some((i) => mentions(i, a))) reasons.push(`ingredients mention ${a.replace(/_/g, " ")}`);
        else if (mentions(p.name, a)) reasons.push(`name mentions ${a.replace(/_/g, " ")}`);
      }
    }
  }
  for (const tag of profile.requiredTags) {
    if (!p.tags.includes(tag)) reasons.push(`not ${tag.replace(/_/g, " ")}`);
  }
  return reasons.length ? { safe: false, reasons: [...new Set(reasons)] } : { safe: true };
}

/** Price per 100 g / 100 ml / 1 item, in cents (rounded to 0.1¢ for comparison). */
export function unitPrice(p: Pick<Product, "priceCents" | "size">): { cents: number; per: string } {
  if (p.size.unit === "each") return { cents: Math.round((p.priceCents / p.size.amount) * 10) / 10, per: "each" };
  return { cents: Math.round((p.priceCents / p.size.amount) * 100 * 10) / 10, per: `100${p.size.unit}` };
}

export function preferenceScore(p: Pick<Product, "tags" | "brand">, profile: SafetyProfile, preferredBrands: string[] = []) {
  const tagHits = profile.preferredTags.filter((t) => p.tags.includes(t)).length;
  return tagHits * 10 + (preferredBrands.includes(p.brand) ? 3 : 0);
}

/** Compare safe options: preference compatibility first, then lower unit price. */
export function rankOptions(products: Product[], profile: SafetyProfile, preferredBrands: string[] = []) {
  return products
    .filter((p) => assessProduct(p, profile).safe)
    .map((p) => ({ product: p, unit: unitPrice(p), score: preferenceScore(p, profile, preferredBrands) }))
    .sort((a, b) => b.score - a.score || a.unit.cents - b.unit.cents || a.product.priceCents - b.product.priceCents);
}

/**
 * Substitutes for an unavailable product: same substitute group, in stock, passes the same safety
 * filter, and is cheaper or equivalent (unit price ≤ original, or at most 10% more when nothing cheaper).
 */
export function findSubstitutes(original: Product, catalog: Product[], profile: SafetyProfile, preferredBrands: string[] = []) {
  const orig = unitPrice(original).cents;
  const pool = catalog.filter((p) => p.id !== original.id && p.substituteGroup === original.substituteGroup && p.inStock);
  const ranked = rankOptions(pool, profile, preferredBrands);
  const cheaper = ranked.filter((r) => r.unit.cents <= orig);
  const close = ranked.filter((r) => r.unit.cents > orig && r.unit.cents <= orig * 1.1);
  return [...cheaper, ...close];
}

// ── Cart ───────────────────────────────────────────────────────────────────

export type LineSource = "usual" | "user_request" | "essential_confirmed" | "substitution" | "assistant_suggestion";

export interface CartLine {
  lineId: string;
  productId: string;
  name: string;
  brand: string;
  quantity: number;
  unitPriceCents: number;
  source: LineSource;
  /** Present when this line replaced an unavailable product after confirmation. */
  substitutedFor?: { productId: string; name: string };
}

export interface PendingSubstitution {
  id: string;
  lineId: string;
  original: { productId: string; name: string };
  substitute: { productId: string; name: string; priceCents: number };
  reason: string;
}

export interface PendingAddition {
  id: string;
  productId: string;
  name: string;
  quantity: number;
  reason: string;
}

export interface BlockedItem {
  productId: string;
  name: string;
  source: LineSource | "untrusted_suggestion";
  reasons: string[];
  at: number;
}

export interface Cart {
  id: string;
  status: "open" | "ordered" | "abandoned";
  lines: CartLine[];
  /** Unavailable items with a proposed substitute awaiting the user's confirmation. */
  pendingSubstitutions: PendingSubstitution[];
  /** Missing household essentials the user hasn't said yes to yet. */
  pendingAdditions: PendingAddition[];
  /** Requested items that could not be added (unsafe, unknown allergens, unavailable with no safe swap). */
  blocked: BlockedItem[];
  unavailable: Array<{ productId: string; name: string }>;
  deliveryWindow: { id: string; label: string; start: number; end: number } | null;
  createdAt: number;
  updatedAt: number;
  /** Incremented on every change; part of the approval-bound cart hash. */
  version: number;
  demo: boolean;
}

export interface CartTotals {
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  itemCount: number;
}

export function cartTotals(cart: Pick<Cart, "lines">, deliveryFeeCents = 499): CartTotals {
  const subtotal = cart.lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  return {
    subtotalCents: subtotal,
    deliveryFeeCents: cart.lines.length ? deliveryFeeCents : 0,
    totalCents: subtotal + (cart.lines.length ? deliveryFeeCents : 0),
    itemCount: cart.lines.reduce((s, l) => s + l.quantity, 0),
  };
}

export interface SpendingLimits {
  perOrderCents: number;
  weeklyCents: number;
}

export interface PlacedOrderSpend {
  placedAt: number;
  totalCents: number;
  status: string;
}

export type SpendCheck =
  | { ok: true; weekSpentCents: number }
  | { ok: false; weekSpentCents: number; violations: string[] };

/** Per-order and trailing-7-day limits. Cancelled/failed orders don't count. */
export function checkSpending(totalCents: number, orders: PlacedOrderSpend[], now: number, limits: SpendingLimits): SpendCheck {
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const weekSpentCents = orders
    .filter((o) => o.placedAt > weekAgo && o.placedAt <= now && !["cancelled", "failed", "rejected"].includes(o.status))
    .reduce((s, o) => s + o.totalCents, 0);
  const violations: string[] = [];
  if (totalCents > limits.perOrderCents) {
    violations.push(`order total ${fmt(totalCents)} is over the per-order limit of ${fmt(limits.perOrderCents)}`);
  }
  if (weekSpentCents + totalCents > limits.weeklyCents) {
    violations.push(
      `this order would bring the 7-day total to ${fmt(weekSpentCents + totalCents)}, over the weekly limit of ${fmt(limits.weeklyCents)}`,
    );
  }
  return violations.length ? { ok: false, weekSpentCents, violations } : { ok: true, weekSpentCents };
}

export function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
