/**
 * Care's live grocery workflow (Apify):
 *   preferred items -> Apify Actor product discovery -> compare -> cart -> approval.
 *
 * The comparison is deterministic code, not a model decision: for each list
 * item Care keeps priced, not-out-of-stock offers that strongly match, then
 * picks the cheapest, preferring fresher observations on ties. Nothing is
 * purchased here; the cart only moves forward through requestOrderApproval
 * after the person approves it.
 */

import { getGroceryDiscoveryProvider, type GroceryDiscovery, type ProductOffer } from "@/integrations/apify";
import type { ToolContext } from "../base/types";

export const DEFAULT_USUAL = ["milk", "bread", "eggs", "bananas", "oats"];

/** Offers below this relevance are never put in a cart. */
const MIN_CART_MATCH = 0.6;
/** Offers within this distance of the item's best match compete on price. */
const MATCH_BAND = 0.15;
/** Keep at most this many offers per item in memory (UI alternatives). */
const KEEP_PER_ITEM = 5;

export interface CartLine {
  productId: string;
  query: string;
  name: string;
  brand: string | null;
  size: string | null;
  quantity: number;
  price: number;
  pricePer: ProductOffer["pricePer"];
  lineTotal: number;
  currency: string;
  retailer: string | null;
  storeLocation: string | null;
  availability: ProductOffer["availability"];
  priceObservedAt: string | null;
  sourceUrl: string;
  /** True when the price is per weight and the line assumes one unit of weight. */
  estimated: boolean;
  alternatives: number;
  reason: string;
}

export interface CartPlan {
  lines: CartLine[];
  missing: { query: string; reason: string }[];
  total: number;
  currency: string;
  retailers: string[];
}

/** Pick the offer Care would put in the cart for one item, with a plain-language reason. */
export function chooseOffer(offers: ProductOffer[]): { offer: ProductOffer; reason: string; alternatives: number } | null {
  const usable = offers.filter((o) => o.price != null && o.availability !== "out_of_stock" && o.matchScore >= MIN_CART_MATCH);
  if (!usable.length) return null;
  const best = Math.max(...usable.map((o) => o.matchScore));
  const strong = usable.filter((o) => o.matchScore >= best - MATCH_BAND);
  strong.sort(
    (a, b) => a.price! - b.price! || (b.priceObservedAt ?? "").localeCompare(a.priceObservedAt ?? "") || b.matchScore - a.matchScore,
  );
  const offer = strong[0];
  const where = offer.retailer ? ` at ${offer.retailer}` : "";
  const reason =
    strong.length > 1
      ? `Cheapest of ${strong.length} close matches${where}.`
      : usable.length > 1
        ? `Best match for the item${where}.`
        : `Only priced match found${where}.`;
  return { offer, reason, alternatives: usable.length - 1 };
}

export function planCart(discovery: Pick<GroceryDiscovery, "items" | "offers">): CartPlan {
  const lines: CartLine[] = [];
  const missing: CartPlan["missing"] = [];
  for (const item of discovery.items) {
    const offers = discovery.offers.filter((o) => o.query.toLowerCase() === item.query.toLowerCase());
    const choice = chooseOffer(offers);
    if (!choice) {
      missing.push({
        query: item.query,
        reason: offers.length ? "Found products, but none with a usable recent price." : "No matching products found.",
      });
      continue;
    }
    const { offer } = choice;
    const estimated = offer.pricePer != null && offer.pricePer !== "unit";
    lines.push({
      productId: offer.offerId,
      query: item.query,
      name: offer.productName,
      brand: offer.brand,
      size: offer.size,
      quantity: item.quantity,
      price: offer.price!,
      pricePer: offer.pricePer,
      lineTotal: Number((offer.price! * item.quantity).toFixed(2)),
      currency: offer.currency ?? "USD",
      retailer: offer.retailer,
      storeLocation: offer.storeLocation,
      availability: offer.availability,
      priceObservedAt: offer.priceObservedAt,
      sourceUrl: offer.sourceUrl,
      estimated,
      alternatives: choice.alternatives,
      reason: estimated ? `${choice.reason} Priced per ${offer.pricePer}; estimated for 1 ${offer.pricePer}.` : choice.reason,
    });
  }
  const total = Number(lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
  const retailers = [...new Set(lines.map((l) => l.retailer).filter((r): r is string => !!r))];
  return { lines, missing, total, currency: lines[0]?.currency ?? "USD", retailers };
}

/**
 * Pull an explicit shopping list out of a request like "buy milk, coffee and
 * apples". Returns null for "buy my usual groceries" and other non-lists.
 */
export function parseRequestedItems(message: string): string[] | null {
  const m = message
    .trim()
    .match(/^(?:(?:please|can you|could you|i need to|i want to)\s+)?(?:buy|order|get me|pick up)\s+(?:me\s+)?(?:some\s+)?(.+)$/i);
  if (!m) return null;
  const rest = m[1].replace(/[.!?]+$/, "").replace(/\b(?:please|for me|today|tomorrow)\b/gi, "").trim();
  if (!rest || /\b(usual|groceries|grocery|regular|shopping)\b/i.test(rest) || /\b(medic|pill|prescription|refill)/i.test(rest)) return null;
  const items = rest
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length <= 80);
  return items.length ? items : null;
}

/** The person's usual items from shared household preferences. */
export async function usualGroceries(ctx: Pick<ToolContext, "memory">): Promise<string[]> {
  const prefs = await ctx.memory.readShared("groceryPreferences").catch(() => []);
  const usual = prefs[0]?.data.usual;
  return Array.isArray(usual) && usual.every((u) => typeof u === "string") && usual.length ? (usual as string[]) : DEFAULT_USUAL;
}

export interface DiscoveryRecordData {
  items: string[];
  backend: GroceryDiscovery["backend"];
  fallbackFrom: GroceryDiscovery["fallbackFrom"] | null;
  run: GroceryDiscovery["run"];
  summaries: GroceryDiscovery["items"];
  offers: ProductOffer[];
  warnings: string[];
  generatedAt: string;
}

/** Run Apify product discovery for a list and keep the result in Care's memory. */
export async function runGroceryDiscovery(
  ctx: ToolContext,
  items: string[],
  opts: { retailer?: string } = {},
): Promise<{ discoveryId: string; discovery: GroceryDiscovery }> {
  const provider = getGroceryDiscoveryProvider();
  const discovery = await provider.discover({ shoppingList: items, maxResultsPerItem: 5, retailer: opts.retailer });
  const kept = discovery.items.flatMap((s) =>
    discovery.offers.filter((o) => o.query.toLowerCase() === s.query.toLowerCase()).slice(0, KEEP_PER_ITEM),
  );
  const data: DiscoveryRecordData = {
    items,
    backend: discovery.backend,
    fallbackFrom: discovery.fallbackFrom ?? null,
    run: discovery.run,
    summaries: discovery.items,
    offers: kept,
    warnings: discovery.warnings.slice(0, 20),
    generatedAt: discovery.generatedAt,
  };
  const rec = await ctx.memory.save("productDiscoveries", data as unknown as Record<string, unknown>, {
    tags: ["grocery", "discovery", discovery.backend],
  });
  await ctx.audit.record({
    actor: "care",
    action: "grocery.discovery",
    correlationId: ctx.correlationId,
    detail: {
      discoveryId: rec.id,
      backend: discovery.backend,
      fallbackFrom: discovery.fallbackFrom ?? null,
      apifyRunId: discovery.run?.runId ?? null,
      items: items.length,
      priced: discovery.items.filter((i) => i.status === "priced").length,
    },
  });
  return { discoveryId: rec.id, discovery: { ...discovery, offers: kept } };
}

export function backendLabel(d: Pick<DiscoveryRecordData, "backend" | "run">): string {
  if (d.backend === "apify") return `Apify run ${d.run?.runId ?? ""}`.trim();
  if (d.backend === "local") return "the discovery Actor's code running locally (not on Apify)";
  return "the offline sandbox catalog";
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * Build a cart from a stored discovery and (by default) ask the person to
 * approve it. Returns the cart and the pending approval.
 */
export async function prepareCartFromDiscovery(
  ctx: ToolContext,
  discoveryId: string,
  opts: { requestApproval?: boolean } = {},
): Promise<
  | { ok: false; error: string }
  | { ok: true; cartId: string; approvalId: string | null; plan: CartPlan; discovery: DiscoveryRecordData }
> {
  const rec = await ctx.memory.get(discoveryId);
  if (!rec || rec.collection !== "productDiscoveries") return { ok: false, error: "discovery_not_found" };
  const discovery = rec.data as unknown as DiscoveryRecordData;
  const plan = planCart({ items: discovery.summaries, offers: discovery.offers });
  if (!plan.lines.length) return { ok: false, error: "no_priced_items" };

  const merchant = plan.retailers.length === 1 ? plan.retailers[0] : plan.retailers.length ? "Multiple stores" : "Sahaya Grocery";
  const cart = await ctx.memory.save(
    "carts",
    {
      lines: plan.lines,
      missing: plan.missing,
      total: plan.total,
      currency: plan.currency,
      merchant,
      retailers: plan.retailers,
      discoveryId,
      discoveryBackend: discovery.backend,
      apifyRunId: discovery.run?.runId ?? null,
      status: "ready",
    },
    { tags: ["cart", "grocery"] },
  );

  let approvalId: string | null = null;
  if (opts.requestApproval !== false) {
    const itemsText = plan.lines.map((l) => `${l.quantity > 1 ? `${l.quantity} x ` : ""}${l.name} ${money(l.lineTotal)}`).join(", ");
    const missingText = plan.missing.length ? ` Not found: ${plan.missing.map((m) => m.query).join(", ")}.` : "";
    const approval = await ctx.approvals.request({
      toolName: "requestOrderApproval",
      toolInput: { cartId: cart.id },
      title: "Place grocery order",
      description: `${plan.lines.length} item(s), ${money(plan.total)} from ${plan.retailers.join(", ") || "the store"}: ${itemsText}.${missingText} Prices from ${backendLabel(discovery)}.`,
      correlationId: ctx.correlationId,
    });
    approvalId = approval.id;
  }
  return { ok: true, cartId: cart.id, approvalId, plan, discovery };
}
