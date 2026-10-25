import type { CartLine, CartTotals, ShoppingCart } from "./types";

export const DELIVERY_FEE = 3.99;
export const FREE_DELIVERY_OVER = 35;

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeTotals(lines: CartLine[]): CartTotals {
  const subtotal = cents(lines.reduce((s, l) => s + (l.decision === "skipped" ? 0 : l.lineTotal), 0));
  const deliveryFee = subtotal === 0 || subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEE;
  return { subtotal, deliveryFee, total: cents(subtotal + deliveryFee) };
}

/**
 * FNV-1a fingerprint of everything the person sees and approves: each priced
 * line (product, quantity, unit price) plus the total. Pure TS so it runs in
 * any runtime. Checkout refuses if the cart no longer matches the approved hash.
 */
export function cartHash(
  lines: (Pick<CartLine, "productId" | "quantity" | "unitPrice"> & { decision?: CartLine["decision"] })[],
  total: number,
): string {
  const canonical = lines
    .filter((l) => l.decision !== "skipped")
    .map((l) => `${l.productId}:${l.quantity}:${l.unitPrice.toFixed(2)}`)
    .sort()
    .join("|");
  const text = `${canonical}#${total.toFixed(2)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function buildCart(lines: CartLine[]): ShoppingCart {
  const totals = computeTotals(lines);
  return { lines, ...totals, cartHash: cartHash(lines, totals.total), status: "ready" };
}

/** Plain-language summary suitable for reading aloud. */
export function speakableCart(cart: Pick<ShoppingCart, "lines" | "total" | "deliveryFee">): string {
  const kept = cart.lines.filter((l) => l.decision !== "skipped");
  const subs = cart.lines.filter((l) => l.decision === "substituted");
  const skips = cart.lines.filter((l) => l.decision === "skipped");
  const parts = [`Your cart has ${kept.length} item${kept.length === 1 ? "" : "s"}, and the total is $${cart.total.toFixed(2)}${cart.deliveryFee ? ` including $${cart.deliveryFee.toFixed(2)} delivery` : " with free delivery"}.`];
  for (const s of subs) parts.push(`For ${s.label.toLowerCase()}: ${s.reason}`);
  for (const s of skips) parts.push(`${s.label}: ${s.reason}`);
  return parts.join(" ");
}
