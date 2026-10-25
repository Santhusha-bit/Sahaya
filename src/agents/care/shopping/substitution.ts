/**
 * Substitution policy: a PURE, deterministic engine that decides which product
 * fills each usual item. Following the project rule (code, not prompt, makes the
 * decision), the model never picks a substitute; it can only phrase this
 * engine's result.
 *
 * Rules, in order:
 *   1. A product is eligible only if it is in stock, carries every required tag
 *      for the item, carries no avoided (dietary) tag, and contains no disliked
 *      term in its name.
 *   2. The person's usual product (preferred brand, eligible) always wins.
 *   3. Otherwise, if she allows substitution for this item, pick the closest
 *      eligible product in the same category whose price is within the allowed
 *      increase over her usual price.
 *   4. If nothing reasonable exists, SKIP the item and say why, rather than
 *      buying something she would not want.
 */

import type { CartLine, ProductCandidate, ShoppingProfile, UsualItem } from "./types";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function rejectionReason(p: ProductCandidate, item: UsualItem, profile: ShoppingProfile): string | null {
  if (!p.inStock) return "out of stock";
  const tags = p.tags.map((t) => t.toLowerCase());
  const missing = (item.requiredTags ?? []).find((t) => !tags.includes(t.toLowerCase()));
  if (missing) return `not ${missing}`;
  const avoided = profile.avoidTags.find((t) => tags.includes(t.toLowerCase()));
  if (avoided) return `${avoided}`;
  const name = `${p.brand ?? ""} ${p.name}`.toLowerCase();
  const disliked = profile.dislikedTerms.find((t) => name.includes(t.toLowerCase()));
  if (disliked) return `contains "${disliked}"`;
  return null;
}

function isPreferred(p: ProductCandidate, item: UsualItem): boolean {
  if (!item.preferredBrand) return false;
  const brand = item.preferredBrand.toLowerCase();
  return (p.brand ?? "").toLowerCase() === brand || p.name.toLowerCase().includes(brand);
}

function line(item: UsualItem, p: ProductCandidate, decision: CartLine["decision"], reason: string): CartLine {
  return {
    itemKey: item.key,
    label: item.label,
    decision,
    reason,
    productId: p.productId,
    productName: p.name,
    brand: p.brand,
    size: p.size,
    quantity: item.quantity,
    unitPrice: cents(p.price),
    lineTotal: cents(p.price * item.quantity),
    source: p.source,
    url: p.url,
  };
}

function skipped(item: UsualItem, reason: string): CartLine {
  return { itemKey: item.key, label: item.label, decision: "skipped", reason, quantity: 0, unitPrice: 0, lineTotal: 0 };
}

/** Decide one cart line for one usual item. Deterministic for a given input. */
export function chooseProduct(item: UsualItem, candidates: ProductCandidate[], profile: ShoppingProfile): CartLine {
  const valid = candidates.filter((p) => Number.isFinite(p.price) && p.price > 0);
  const eligible = valid.filter((p) => rejectionReason(p, item, profile) === null);
  const preferredAny = item.preferredBrand ? valid.find((p) => isPreferred(p, item)) : undefined;

  // Rule 2: the usual product.
  const usual = eligible.filter((p) => isPreferred(p, item)).sort((a, b) => a.price - b.price)[0];
  if (usual) return line(item, usual, "usual", `Your usual ${usual.brand ?? usual.name}.`);
  if (!item.preferredBrand) {
    // No brand preference: the cheapest eligible product in the category is "usual".
    const generic = eligible
      .filter((p) => p.category === item.category && p.price <= item.usualPrice * (1 + profile.maxSubstitutionIncrease))
      .sort((a, b) => a.price - b.price)[0];
    if (generic) return line(item, generic, "usual", `Same as you usually get, ${money(generic.price)}.`);
  }

  const whyNotUsual = preferredAny
    ? `Your usual ${item.preferredBrand} is ${rejectionReason(preferredAny, item, profile) ?? "unavailable"}`
    : item.preferredBrand
      ? `I couldn't find your usual ${item.preferredBrand}`
      : `I couldn't find your usual ${item.label.toLowerCase()}`;

  // Rule 3: substitution, only if allowed.
  if (!item.allowSubstitution) {
    return skipped(item, `${whyNotUsual}, and you asked me not to swap this one, so I left it off.`);
  }
  const cap = item.usualPrice * (1 + profile.maxSubstitutionIncrease);
  const subs = eligible
    .filter((p) => p.category === item.category && p.price <= cap)
    .sort((a, b) => Math.abs(a.price - item.usualPrice) - Math.abs(b.price - item.usualPrice) || a.price - b.price);
  const sub = subs[0];
  if (sub) {
    const diff = cents(sub.price - item.usualPrice);
    const priceNote =
      diff > 0.004 ? `${money(diff)} more than usual` : diff < -0.004 ? `${money(-diff)} less than usual` : "the same price";
    const tagNote = (item.requiredTags ?? []).length ? `, still ${item.requiredTags!.join(", ")}` : "";
    return line(item, sub, "substituted", `${whyNotUsual}, so I picked ${sub.brand ?? sub.name} instead (${priceNote}${tagNote}).`);
  }

  // Rule 4: nothing reasonable, so skip rather than buy something unwanted.
  const tooPricey = eligible.some((p) => p.category === item.category && p.price > cap);
  return skipped(
    item,
    `${whyNotUsual}${tooPricey ? ", and the alternatives cost much more than you usually pay" : ", and there was no good alternative"}, so I left it off.`,
  );
}
