/**
 * Care shopping orchestration. Every step of the Visa "Reimagining shopping"
 * workflow runs through here, from either Care's tools (voice/chat) or the
 * accessible /shop screen:
 *
 *   1. retrieve shopping history + preferences   (loadProfile)
 *   2. search products                           (Apify, or sandbox catalog)
 *   3. choose usual items / substitutions         (pure substitution policy)
 *   4. build an accessible cart with a clear total (pure cart math + hash)
 *   5. request approval bound to that exact cart   (approval gate)
 *   6. checkout after approval                     (sandbox checkout, enforced checks)
 *   7. track the order                             (provider tracking)
 *
 * Code makes every purchase decision; the language model only phrases results.
 */

import { searchItem, getProductSearchProvider, type ProductSearchProvider } from "@/integrations/apify";
import { currentStage, getCheckoutProvider, type CheckoutProvider } from "@/integrations/checkout";
import type { MemoryRecord, ToolContext } from "../../base/types";
import { buildCart, cartHash, speakableCart } from "./cart";
import { demoOrderHistory, demoShoppingProfile } from "./profile";
import { chooseProduct } from "./substitution";
import type { CartLine, PastOrder, ShoppingCart, ShoppingProfile, TrackingStep } from "./types";

type Mem = ToolContext["memory"];

function newest(rows: MemoryRecord[]): MemoryRecord[] {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

/* ------------------------------------------------------------- 1. profile */

export async function loadProfile(memory: Mem, displayName = "Margaret"): Promise<{ profile: ShoppingProfile; history: PastOrder[] }> {
  let [profileRec] = newest(await memory.list("shoppingProfile", { limit: 5 }));
  let historyRows = await memory.list("orderHistory");
  if (!profileRec) {
    // First use: seed the demo history and preferences for this person.
    if (!historyRows.length) {
      for (const o of demoOrderHistory()) await memory.save("orderHistory", { ...o }, { tags: ["shopping"] });
      historyRows = await memory.list("orderHistory");
    }
    profileRec = await memory.save("shoppingProfile", { ...demoShoppingProfile(memory.userId, displayName) }, { tags: ["shopping"] });
  }
  const history = historyRows
    .map((r) => r.data as unknown as PastOrder)
    .sort((a, b) => b.placedAt - a.placedAt);
  return { profile: profileRec.data as unknown as ShoppingProfile, history };
}

/* ------------------------------------------------- 2-4. search + cart build */

export interface BuiltCart {
  cartId: string;
  cart: ShoppingCart;
  searchBackend: "apify" | "sandbox" | "mixed";
  fallbacks: { itemKey: string; reason: string }[];
  spoken: string;
}

export async function buildUsualCart(
  ctx: Pick<ToolContext, "memory">,
  opts: { exclude?: string[]; provider?: ProductSearchProvider } = {},
): Promise<BuiltCart> {
  const { profile } = await loadProfile(ctx.memory);
  const exclude = new Set((opts.exclude ?? []).map((s) => s.toLowerCase()));
  const items = profile.usualItems.filter((i) => !exclude.has(i.key));
  const provider = opts.provider ?? getProductSearchProvider();

  const results = await Promise.all(
    items.map((item) => searchItem({ query: item.query, category: item.category, limit: 8 }, provider)),
  );
  const lines: CartLine[] = items.map((item, i) => chooseProduct(item, results[i].candidates, profile));
  const fallbacks = items
    .map((item, i) => ({ itemKey: item.key, reason: results[i].fallbackReason }))
    .filter((f): f is { itemKey: string; reason: string } => !!f.reason);
  const backends = new Set(results.map((r) => r.backend));
  const searchBackend = backends.size > 1 ? "mixed" : (results[0]?.backend ?? provider.backend);

  const cart = buildCart(lines);
  await supersedeOpenCarts(ctx.memory);
  const rec = await ctx.memory.save(
    "carts",
    { ...cart, searchBackend, fallbacks, kind: "usual" },
    { tags: ["cart", "shopping"] },
  );
  return { cartId: rec.id, cart, searchBackend, fallbacks, spoken: speakableCart(cart) };
}

async function supersedeOpenCarts(memory: Mem): Promise<void> {
  for (const c of await memory.list("carts")) {
    if (c.data.status === "ready") await memory.update(c.id, { status: "superseded" });
  }
}

/** Remove one item from a ready cart. Produces a NEW cart (new hash), superseding the old. */
export async function removeCartItem(ctx: Pick<ToolContext, "memory">, cartId: string, itemKey: string): Promise<BuiltCart | null> {
  const rec = await ctx.memory.get(cartId);
  if (!rec || rec.data.status !== "ready") return null;
  const old = rec.data as unknown as ShoppingCart & { searchBackend: BuiltCart["searchBackend"]; fallbacks: BuiltCart["fallbacks"] };
  const lines = old.lines.filter((l) => l.itemKey !== itemKey);
  if (lines.length === old.lines.length) return null;
  const cart = buildCart(lines);
  await supersedeOpenCarts(ctx.memory);
  const next = await ctx.memory.save(
    "carts",
    { ...cart, searchBackend: old.searchBackend, fallbacks: old.fallbacks, kind: "usual" },
    { tags: ["cart", "shopping"] },
  );
  return { cartId: next.id, cart, searchBackend: old.searchBackend, fallbacks: old.fallbacks, spoken: speakableCart(cart) };
}

/* ------------------------------------------------------------ 5. approval */

export function approvalText(cart: Pick<ShoppingCart, "lines" | "total">, profile: Pick<ShoppingProfile, "paymentMethod">) {
  const count = cart.lines.filter((l) => l.decision !== "skipped").length;
  return {
    title: `Buy ${count} groceries for $${cart.total.toFixed(2)}`,
    description: `Pay $${cart.total.toFixed(2)} with ${profile.paymentMethod.label}. Sandbox checkout: no real money moves.`,
  };
}

/** Ask for approval bound to this exact cart (id + hash + total). Expires older pending order approvals. */
export async function requestCartApproval(ctx: Pick<ToolContext, "memory" | "approvals" | "correlationId">, built: BuiltCart) {
  const { profile } = await loadProfile(ctx.memory);
  for (const a of await ctx.approvals.list("pending")) {
    if (a.toolName === "requestOrderApproval") await ctx.approvals.expire(a.id);
  }
  const { title, description } = approvalText(built.cart, profile);
  return ctx.approvals.request({
    toolName: "requestOrderApproval",
    toolInput: { cartId: built.cartId, cartHash: built.cart.cartHash, total: built.cart.total },
    title,
    description,
    correlationId: ctx.correlationId,
  });
}

/* ------------------------------------------------------------ 6. checkout */

export type CheckoutRefusal =
  | "cart_not_found"
  | "cart_already_ordered"
  | "cart_superseded"
  | "cart_changed"
  | "empty_cart"
  | "over_spending_limit";

/**
 * Deterministic pre-checkout checks. Approval is necessary but not sufficient:
 * the cart must still be the one approved (same hash and total), not already
 * ordered, and within the person's spending limit.
 */
export function checkoutRefusal(
  cart: MemoryRecord | null,
  approved: { cartHash?: string; total?: number },
  profile: Pick<ShoppingProfile, "spendingLimit">,
): CheckoutRefusal | null {
  if (!cart) return "cart_not_found";
  const status = cart.data.status;
  if (status === "ordered") return "cart_already_ordered";
  if (status === "superseded") return "cart_superseded";
  const lines = (cart.data.lines as CartLine[]) ?? [];
  const total = Number(cart.data.total ?? 0);
  const stored = typeof cart.data.cartHash === "string" ? cart.data.cartHash : undefined;
  if (stored) {
    const recomputed = cartHash(
      lines.map((l) => ({ ...l, unitPrice: Number(l.unitPrice ?? (l as unknown as { price?: number }).price ?? 0) })),
      total,
    );
    if (recomputed !== stored) return "cart_changed";
    if (approved.cartHash !== undefined && approved.cartHash !== stored) return "cart_changed";
  }
  if (approved.total !== undefined && Math.abs(approved.total - total) > 0.004) return "cart_changed";
  if (!lines.some((l) => l.decision !== "skipped" && Number(l.quantity) > 0)) return "empty_cart";
  if (total > profile.spendingLimit) return "over_spending_limit";
  return null;
}

export const REFUSAL_TEXT: Record<CheckoutRefusal, string> = {
  cart_not_found: "That cart no longer exists.",
  cart_already_ordered: "That cart was already ordered, so I didn't charge it again.",
  cart_superseded: "That cart was replaced by a newer one. Please approve the current cart instead.",
  cart_changed: "The cart changed after you approved it, so I stopped. Please review the new total and approve again.",
  empty_cart: "There's nothing in that cart to order.",
  over_spending_limit: "This order is over your spending limit, so I need a family member to review it first.",
};

export async function checkoutCart(
  ctx: Pick<ToolContext, "memory" | "userId">,
  input: { cartId: string; cartHash?: string; total?: number },
  provider: CheckoutProvider = getCheckoutProvider(),
) {
  const { profile } = await loadProfile(ctx.memory);
  const cart = await ctx.memory.get(input.cartId);
  const refusal = checkoutRefusal(cart, input, profile);
  if (refusal) return { ok: false as const, refusal, message: REFUSAL_TEXT[refusal] };

  const lines = (cart!.data.lines as CartLine[]) ?? [];
  const kept = lines.filter((l) => l.decision !== "skipped");
  const total = Number(cart!.data.total ?? 0);
  const hash = String(cart!.data.cartHash ?? "legacy");
  const placed = await provider.placeOrder({
    userId: ctx.userId,
    cartHash: hash,
    total,
    itemCount: kept.length,
    paymentTokenRef: profile.paymentMethod.tokenRef,
    idempotencyKey: `${input.cartId}:${hash}`,
  });
  await ctx.memory.update(input.cartId, { status: "ordered" });
  const order = await ctx.memory.save(
    "orders",
    {
      cartId: input.cartId,
      cartHash: hash,
      total,
      itemCount: kept.length,
      items: kept.map((l) => l.productName ?? l.label),
      status: "placed",
      orderRef: placed.orderRef,
      placedAt: placed.placedAt,
      backend: placed.backend,
      trackingSupported: placed.trackingSupported,
      notice: placed.notice,
      paymentLabel: profile.paymentMethod.label,
    },
    { tags: ["order"] },
  );
  await ctx.memory.save(
    "orderHistory",
    { placedAt: placed.placedAt, items: kept.map((l) => l.itemKey), total },
    { tags: ["shopping"] },
  );
  return { ok: true as const, orderId: order.id, order: order.data, placed, total, itemCount: kept.length };
}

/* ------------------------------------------------------------ 7. tracking */

export async function trackLatestOrder(
  ctx: Pick<ToolContext, "memory">,
  orderId?: string,
  provider: CheckoutProvider = getCheckoutProvider(),
): Promise<{ orderId: string; order: Record<string, unknown>; steps: TrackingStep[]; current: TrackingStep } | null> {
  const rec = orderId ? await ctx.memory.get(orderId) : newest(await ctx.memory.list("orders", { limit: 10 }))[0];
  if (!rec || rec.collection !== "orders") return null;
  const placedAt = Number(rec.data.placedAt ?? rec.createdAt);
  if (rec.data.trackingSupported === false || !rec.data.orderRef) {
    const steps: TrackingStep[] = [{ stage: "placed", label: "Order placed", done: true, at: placedAt }];
    return { orderId: rec.id, order: rec.data, steps, current: steps[0] };
  }
  const steps = provider.track({ orderRef: String(rec.data.orderRef), placedAt });
  const current = currentStage(steps);
  if (rec.data.status !== current.stage) await ctx.memory.update(rec.id, { status: current.stage });
  return { orderId: rec.id, order: { ...rec.data, status: current.stage }, steps, current };
}

/** Everything the accessible /shop screen needs, in one read. */
export async function shoppingSnapshot(ctx: Pick<ToolContext, "memory" | "approvals">) {
  const { profile, history } = await loadProfile(ctx.memory);
  const carts = newest(await ctx.memory.list("carts", { tag: "shopping" }));
  const cartRec = carts.find((c) => c.data.status === "ready") ?? null;
  const pending = cartRec
    ? (await ctx.approvals.list("pending")).find(
        (a) => a.toolName === "requestOrderApproval" && (a.input as { cartId?: string })?.cartId === cartRec.id,
      ) ?? null
    : null;
  const tracking = await trackLatestOrder(ctx);
  return {
    profile: {
      displayName: profile.displayName,
      usualItems: profile.usualItems.map((i) => ({ key: i.key, label: i.label, timesOrdered: i.timesOrdered })),
      paymentLabel: profile.paymentMethod.label,
      spendingLimit: profile.spendingLimit,
      dietary: profile.avoidTags,
      ordersInHistory: history.length,
    },
    cart: cartRec ? { cartId: cartRec.id, ...(cartRec.data as unknown as ShoppingCart & { searchBackend: string }), spoken: speakableCart(cartRec.data as unknown as ShoppingCart) } : null,
    approval: pending ? { id: pending.id, title: pending.title, description: pending.description } : null,
    order: tracking,
  };
}
