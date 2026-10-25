import { hashValue, newId } from "@/lib/ids";
import { AgentError, isAgentError, toErrorMessage } from "../../base/errors";
import { EVENT_TYPES } from "../../contracts";
import { resolveAdapter, type DeliveryWindow } from "../adapters";
import {
  assessProduct,
  cartTotals,
  checkSpending,
  findSubstitutes,
  fmt,
  rankOptions,
  unitPrice,
  type BlockedItem,
  type Cart,
  type CartLine,
  type LineSource,
  type Product,
} from "../domain/grocery";
import { sanitizeUntrusted } from "../domain/untrusted";
import { NS, type GroceryPreferences, type OrderRecord } from "../repository";
import { MemoryService } from "./memoryService";
import type { CareEnv } from "./env";

export interface OrderSummary {
  cartId: string;
  cartHash: string;
  lines: Array<{ name: string; brand: string; quantity: number; lineTotal: string; substitutedFor?: string }>;
  pendingSubstitutions: Cart["pendingSubstitutions"];
  pendingAdditions: Cart["pendingAdditions"];
  blocked: Array<{ name: string; reasons: string[] }>;
  unavailable: string[];
  totals: ReturnType<typeof cartTotals>;
  deliveryWindow: DeliveryWindow | null;
  spending: { ok: boolean; weekSpentCents: number; violations: string[]; perOrderCents: number; weeklyCents: number };
  readyForApproval: boolean;
  blockers: string[];
  plainText: string;
  simulated: true;
}

export class GroceryService {
  constructor(private readonly env: CareEnv) {}

  private get repo() {
    return this.env.repo;
  }
  private grocery() {
    return resolveAdapter(this.env.adapters.grocery, this.env.integrationMode);
  }

  async preferences(userId: string): Promise<GroceryPreferences> {
    const p = await this.repo.preferences(userId);
    // A new person starts with empty preferences (and default spending limits), never invented ones.
    return p ?? new MemoryService(this.env).ensurePreferences(userId);
  }

  private async timeZone(userId: string) {
    return (await this.repo.profile(userId))?.timeZone ?? "UTC";
  }

  /** Safe, ranked search results. Unsafe matches are reported (with reasons), never offered. */
  async search(userId: string, query: string, max = 5) {
    const prefs = await this.preferences(userId);
    const matches = await this.grocery().search(userId, query);
    const ranked = rankOptions(matches.filter((p) => p.inStock), prefs.safety, prefs.preferredBrands);
    const excluded = matches
      .map((p) => ({ p, v: assessProduct(p, prefs.safety) }))
      .filter((x) => !x.v.safe)
      .map((x) => ({ productId: x.p.id, name: x.p.name, reasons: x.v.safe ? [] : x.v.reasons }));
    return {
      results: ranked.slice(0, max).map((r) => ({
        productId: r.product.id,
        name: r.product.name,
        brand: r.product.brand,
        size: `${r.product.size.amount} ${r.product.size.unit}`,
        price: fmt(r.product.priceCents),
        unitPrice: `${fmt(r.unit.cents)} per ${r.unit.per}`,
        tags: r.product.tags,
        // Catalog text is untrusted data, wrapped and flagged; it never affects ranking or safety.
        description: sanitizeUntrusted(r.product.description, "catalog", 160),
      })),
      excluded,
      outOfStock: matches.filter((p) => !p.inStock).map((p) => p.name),
    };
  }

  private line(p: Product, quantity: number, source: LineSource, substitutedFor?: Product): CartLine {
    return {
      lineId: newId("line"),
      productId: p.id,
      name: p.name,
      brand: p.brand,
      quantity,
      unitPriceCents: p.priceCents,
      source,
      substitutedFor: substitutedFor ? { productId: substitutedFor.id, name: substitutedFor.name } : undefined,
    };
  }

  /**
   * Build a personalized cart: usual items (with substitution proposals for anything unavailable),
   * explicitly requested items, and missing household essentials as *proposals* that need a yes.
   * Every product passes the deterministic safety gate first.
   */
  async buildCart(userId: string, opts: { includeUsual: boolean; items: string[] }): Promise<Cart> {
    const prefs = await this.preferences(userId);
    const catalog = await this.grocery().catalog(userId);
    const byId = new Map(catalog.map((p) => [p.id, p]));
    const now = this.env.now();
    const tz = await this.timeZone(userId);
    const cart: Cart = {
      id: newId("cart"),
      status: "open",
      lines: [],
      pendingSubstitutions: [],
      pendingAdditions: [],
      blocked: [],
      unavailable: [],
      deliveryWindow: this.grocery().deliveryWindows(now, tz)[0],
      createdAt: now,
      updatedAt: now,
      version: 1,
      demo: prefs.demo,
    };
    const block = (p: Product, source: BlockedItem["source"], reasons: string[]) =>
      cart.blocked.push({ productId: p.id, name: p.name, source, reasons, at: now });

    const addProduct = (p: Product, qty: number, source: LineSource) => {
      const verdict = assessProduct(p, prefs.safety);
      if (!verdict.safe) return block(p, source, verdict.reasons);
      if (cart.lines.some((l) => l.productId === p.id)) return;
      if (p.inStock) {
        cart.lines.push(this.line(p, qty, source));
        return;
      }
      cart.unavailable.push({ productId: p.id, name: p.name });
      const sub = findSubstitutes(p, catalog, prefs.safety, prefs.preferredBrands)[0];
      if (sub) {
        cart.pendingSubstitutions.push({
          id: newId("sub"),
          lineId: newId("line"),
          original: { productId: p.id, name: p.name },
          substitute: { productId: sub.product.id, name: `${sub.product.brand} ${sub.product.name}`, priceCents: sub.product.priceCents },
          reason: `${p.name} is out of stock. ${sub.product.brand} ${sub.product.name} passes your allergy and diet filters and costs ${fmt(sub.unit.cents)} per ${sub.unit.per} (was ${fmt(unitPrice(p).cents)}).`,
        });
      }
    };

    if (opts.includeUsual) {
      for (const u of prefs.usualItems) {
        const p = byId.get(u.productId);
        if (p) addProduct(p, u.quantity, "usual");
      }
    }
    for (const raw of opts.items) {
      const query = raw.trim();
      if (!query) continue;
      const matches = await this.grocery().search(userId, query);
      const best = rankOptions(matches.filter((p) => p.inStock), prefs.safety, prefs.preferredBrands)[0];
      if (best) {
        if (!cart.lines.some((l) => l.productId === best.product.id)) cart.lines.push(this.line(best.product, 1, "user_request"));
      } else if (matches.length) {
        const top = matches[0];
        const v = assessProduct(top, prefs.safety);
        block(top, "user_request", v.safe ? ["out of stock with no safe alternative"] : v.reasons);
      } else {
        cart.blocked.push({ productId: "", name: query.slice(0, 60), source: "user_request", reasons: ["not found in the catalog"], at: now });
      }
    }
    // Household essentials: propose what's missing from both the cart and the pantry; ask before adding.
    const pantry = await this.repo.pantry(userId);
    for (const e of prefs.essentials) {
      const inCart = cart.lines.some((l) => byId.get(l.productId)?.substituteGroup === e.substituteGroup) ||
        cart.pendingSubstitutions.some((s) => byId.get(s.original.productId)?.substituteGroup === e.substituteGroup);
      const inPantry = pantry.some((p) => p.quantity > 0 && p.name.toLowerCase().includes(e.label.toLowerCase()));
      if (inCart || inPantry) continue;
      const def = byId.get(e.defaultProductId);
      const choice =
        def && def.inStock && assessProduct(def, prefs.safety).safe
          ? def
          : rankOptions(catalog.filter((p) => p.substituteGroup === e.substituteGroup && p.inStock), prefs.safety, prefs.preferredBrands)[0]?.product;
      if (choice) {
        cart.pendingAdditions.push({ id: newId("add"), productId: choice.id, name: choice.name, quantity: e.quantity, reason: `You usually keep ${e.label} at home and it isn't in your pantry list.` });
      }
    }
    for (const c of await this.repo.carts(userId)) {
      if (c.status === "open") await this.repo.saveCart(userId, { ...c, status: "abandoned", updatedAt: now });
    }
    await this.repo.saveCart(userId, cart);
    await this.env.audit(userId, "tool_result", "Grocery cart built", { cartId: cart.id, lines: cart.lines.length, blocked: cart.blocked.length });
    return cart;
  }

  private async openCart(userId: string, cartId: string) {
    const cart = await this.repo.require<Cart>(userId, NS.carts, cartId, `cart ${cartId}`);
    if (cart.status !== "open") throw new AgentError("VALIDATION_FAILED", `cart is ${cart.status}`);
    return cart;
  }

  private async save(userId: string, cart: Cart) {
    const next = { ...cart, version: cart.version + 1, updatedAt: this.env.now() };
    await this.repo.saveCart(userId, next);
    return next;
  }

  /**
   * Add products by id. Used for user picks and for suggestions from Claude or other untrusted text:
   * the source is recorded and the safety gate runs regardless. Unsafe items land in `blocked`.
   */
  async addItems(userId: string, cartId: string, items: Array<{ productId: string; quantity: number }>, source: LineSource | "untrusted_suggestion") {
    const prefs = await this.preferences(userId);
    let cart = await this.openCart(userId, cartId);
    const added: string[] = [];
    const blocked: Array<{ productId: string; name: string; reasons: string[] }> = [];
    for (const it of items) {
      const p = await this.grocery().getProduct(userId, it.productId);
      if (!p) {
        blocked.push({ productId: it.productId, name: it.productId, reasons: ["unknown product"] });
        continue;
      }
      const v = assessProduct(p, prefs.safety);
      if (!v.safe) {
        blocked.push({ productId: p.id, name: p.name, reasons: v.reasons });
        cart.blocked.push({ productId: p.id, name: p.name, source, reasons: v.reasons, at: this.env.now() });
        await this.env.audit(userId, "tool_result", "Unsafe product blocked by allergy/diet filter", { cartId, productId: p.id, source });
        continue;
      }
      if (!p.inStock) {
        blocked.push({ productId: p.id, name: p.name, reasons: ["out of stock"] });
        continue;
      }
      const existing = cart.lines.find((l) => l.productId === p.id);
      if (existing) existing.quantity = Math.min(50, existing.quantity + it.quantity);
      else cart.lines.push(this.line(p, it.quantity, source === "untrusted_suggestion" ? "assistant_suggestion" : source));
      added.push(p.id);
    }
    cart = await this.save(userId, cart);
    return { cart, added, blocked };
  }

  async removeItem(userId: string, cartId: string, productId: string) {
    const cart = await this.openCart(userId, cartId);
    cart.lines = cart.lines.filter((l) => l.productId !== productId);
    return this.save(userId, cart);
  }

  /** Accept/decline a substitution (sub_*) or a missing essential (add_*). */
  async respond(userId: string, cartId: string, suggestionId: string, decision: "accept" | "decline") {
    const prefs = await this.preferences(userId);
    const cart = await this.openCart(userId, cartId);
    const sub = cart.pendingSubstitutions.find((s) => s.id === suggestionId);
    const add = cart.pendingAdditions.find((a) => a.id === suggestionId);
    if (!sub && !add) throw new AgentError("NOT_FOUND", "suggestion not found (it may already be answered)");
    if (sub) {
      cart.pendingSubstitutions = cart.pendingSubstitutions.filter((s) => s.id !== suggestionId);
      if (decision === "accept") {
        const p = await this.grocery().getProduct(userId, sub.substitute.productId);
        const orig = await this.grocery().getProduct(userId, sub.original.productId);
        if (!p || !orig) throw new AgentError("NOT_FOUND", "product no longer available");
        const v = assessProduct(p, prefs.safety);
        if (!v.safe) throw new AgentError("VALIDATION_FAILED", `substitute is no longer safe: ${v.reasons.join(", ")}`);
        if (!p.inStock) throw new AgentError("VALIDATION_FAILED", "substitute went out of stock");
        const qty = prefs.usualItems.find((u) => u.productId === orig.id)?.quantity ?? 1;
        cart.lines.push(this.line(p, qty, "substitution", orig));
        cart.unavailable = cart.unavailable.filter((u) => u.productId !== orig.id);
      }
    } else if (add) {
      cart.pendingAdditions = cart.pendingAdditions.filter((a) => a.id !== suggestionId);
      if (decision === "accept") {
        const p = await this.grocery().getProduct(userId, add.productId);
        if (!p) throw new AgentError("NOT_FOUND", "product no longer available");
        const v = assessProduct(p, prefs.safety);
        if (!v.safe) throw new AgentError("VALIDATION_FAILED", `not safe: ${v.reasons.join(", ")}`);
        cart.lines.push(this.line(p, add.quantity, "essential_confirmed"));
      }
    }
    const saved = await this.save(userId, cart);
    await this.env.audit(userId, "tool_result", `Cart suggestion ${decision}ed`, { cartId, suggestionId });
    return saved;
  }

  async setDeliveryWindow(userId: string, cartId: string, windowId: string) {
    const cart = await this.openCart(userId, cartId);
    const w = this.grocery().deliveryWindows(this.env.now(), await this.timeZone(userId)).find((x) => x.id === windowId);
    if (!w) throw new AgentError("VALIDATION_FAILED", "unknown delivery window");
    cart.deliveryWindow = w;
    return this.save(userId, cart);
  }

  private static hash(cart: Cart) {
    return hashValue({
      cartId: cart.id,
      version: cart.version,
      lines: cart.lines.map((l) => [l.productId, l.quantity, l.unitPriceCents]),
      window: cart.deliveryWindow?.id ?? null,
    });
  }

  private async weeklyOrders(userId: string) {
    return (await this.repo.orders(userId)).map((o) => ({ placedAt: o.placedAt, totalCents: o.totalCents, status: o.status }));
  }

  /** Plain-language summary plus the exact values an approval must bind to. */
  async summary(userId: string, cartId: string): Promise<OrderSummary> {
    const prefs = await this.preferences(userId);
    const cart = await this.repo.require<Cart>(userId, NS.carts, cartId, `cart ${cartId}`);
    const totals = cartTotals(cart, prefs.deliveryFeeCents);
    const spend = checkSpending(totals.totalCents, await this.weeklyOrders(userId), this.env.now(), prefs.limits);
    const blockers: string[] = [];
    if (cart.status !== "open") blockers.push(`cart is ${cart.status}`);
    if (!cart.lines.length) blockers.push("cart is empty");
    if (cart.pendingSubstitutions.length) blockers.push("substitutions are waiting for a yes or no");
    if (cart.pendingAdditions.length) blockers.push("suggested essentials are waiting for a yes or no");
    if (!cart.deliveryWindow) blockers.push("no delivery window chosen");
    if (!spend.ok) blockers.push(...spend.violations);
    const lines = cart.lines.map((l) => ({
      name: `${l.brand} ${l.name}`,
      brand: l.brand,
      quantity: l.quantity,
      lineTotal: fmt(l.unitPriceCents * l.quantity),
      substitutedFor: l.substitutedFor?.name,
    }));
    const text = [
      `Your order (sandbox — no real purchase):`,
      ...lines.map((l) => `• ${l.quantity} × ${l.name} — ${l.lineTotal}${l.substitutedFor ? ` (instead of ${l.substitutedFor})` : ""}`),
      `Delivery: ${fmt(totals.deliveryFeeCents)}. Total: ${fmt(totals.totalCents)}.`,
      cart.deliveryWindow ? `Delivery window: ${cart.deliveryWindow.label}.` : "No delivery window yet.",
      cart.blocked.length ? `Not added for safety: ${cart.blocked.map((b) => b.name).join(", ")}.` : "",
    ].filter(Boolean);
    return {
      cartId: cart.id,
      cartHash: GroceryService.hash(cart),
      lines,
      pendingSubstitutions: cart.pendingSubstitutions,
      pendingAdditions: cart.pendingAdditions,
      blocked: cart.blocked.map((b) => ({ name: b.name, reasons: b.reasons })),
      unavailable: cart.unavailable.map((u) => u.name),
      totals,
      deliveryWindow: cart.deliveryWindow,
      spending: {
        ok: spend.ok,
        weekSpentCents: spend.weekSpentCents,
        violations: spend.ok ? [] : spend.violations,
        perOrderCents: prefs.limits.perOrderCents,
        weeklyCents: prefs.limits.weeklyCents,
      },
      readyForApproval: blockers.length === 0,
      blockers,
      plainText: text.join("\n"),
      simulated: true,
    };
  }

  /**
   * Server-side verification right before approval is requested AND again right before execution:
   * the cart must be exactly what was summarized (hash, total, window), safe, in stock, and within limits.
   */
  async verifyOrder(userId: string, input: { cartId: string; cartHash: string; totalCents: number; deliveryWindowId: string }) {
    const s = await this.summary(userId, input.cartId);
    if (s.cartHash !== input.cartHash) throw new AgentError("APPROVAL_INVALID", "the cart changed since it was reviewed");
    if (s.totals.totalCents !== input.totalCents) throw new AgentError("APPROVAL_INVALID", "the total differs from the reviewed cart");
    if (s.deliveryWindow?.id !== input.deliveryWindowId) throw new AgentError("APPROVAL_INVALID", "the delivery window differs from the reviewed cart");
    if (!s.readyForApproval) throw new AgentError("VALIDATION_FAILED", `order can't be placed yet: ${s.blockers.join("; ")}`);
    const prefs = await this.preferences(userId);
    const cart = await this.repo.require<Cart>(userId, NS.carts, input.cartId, "cart");
    for (const l of cart.lines) {
      const p = await this.grocery().getProduct(userId, l.productId);
      if (!p) throw new AgentError("VALIDATION_FAILED", `${l.name} is no longer in the catalog`);
      const v = assessProduct(p, prefs.safety);
      if (!v.safe) throw new AgentError("VALIDATION_FAILED", `${l.name} failed the allergy/diet check: ${v.reasons.join(", ")}`);
      if (!p.inStock) throw new AgentError("VALIDATION_FAILED", `${l.name} went out of stock; please review the cart`);
      if (p.priceCents !== l.unitPriceCents) throw new AgentError("VALIDATION_FAILED", `${l.name} changed price; please review the cart`);
    }
    return { summary: s, cart };
  }

  /** Executes only after the ToolRegistry verified and consumed the approval. */
  async placeOrder(userId: string, input: { cartId: string; cartHash: string; totalCents: number; deliveryWindowId: string }) {
    const { summary, cart } = await this.verifyOrder(userId, input);
    const res = await this.grocery().placeOrder(userId, {
      idempotencyKey: `${cart.id}:${summary.cartHash}`,
      lines: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPriceCents: l.unitPriceCents })),
      totalCents: summary.totals.totalCents,
      window: cart.deliveryWindow!,
    });
    const now = this.env.now();
    const existing = (await this.repo.orders(userId)).find((o) => o.providerOrderId === res.providerOrderId);
    if (existing) return { orderId: existing.id, status: existing.status, duplicate: true, simulated: true };
    const order: OrderRecord = {
      id: newId("order"),
      cartId: cart.id,
      cartHash: summary.cartHash,
      lines: cart.lines.map((l) => ({ productId: l.productId, name: `${l.brand} ${l.name}`, quantity: l.quantity, unitPriceCents: l.unitPriceCents, substitutedFor: l.substitutedFor?.name })),
      totalCents: summary.totals.totalCents,
      deliveryWindow: cart.deliveryWindow!,
      status: res.status,
      statusHistory: [{ at: now, status: res.status }],
      placedAt: now,
      providerOrderId: res.providerOrderId,
      simulated: true,
      demo: cart.demo,
    };
    await this.repo.saveOrder(userId, order);
    await this.repo.saveCart(userId, { ...cart, status: "ordered", updatedAt: now });
    await this.recordPurchase(userId, order);
    await this.env.audit(userId, "tool_result", "Grocery order placed with sandbox adapter", { orderId: order.id, totalCents: order.totalCents, simulated: true });
    // Optional cross-agent review; only if the user enabled the Care → Finance route.
    let financeReview = "not_enabled";
    try {
      const evt = await this.env.emit("finance", EVENT_TYPES.paymentReview, {
        orderRef: order.id,
        merchant: "Sandbox grocery",
        amountCents: order.totalCents,
        itemCount: order.lines.reduce((s, l) => s + l.quantity, 0),
        category: "groceries",
      });
      financeReview = evt.status;
    } catch (err) {
      financeReview = isAgentError(err) && err.code === "CONSENT_REQUIRED" ? "not_enabled" : `failed: ${toErrorMessage(err)}`;
    }
    return {
      orderId: order.id,
      status: order.status,
      total: fmt(order.totalCents),
      deliveryWindow: order.deliveryWindow.label,
      simulated: true,
      financeReview,
      note: "Sandbox order — no real purchase was made and nothing will be delivered.",
      duplicate: res.duplicate,
    };
  }

  private async recordPurchase(userId: string, order: OrderRecord) {
    const key = "history";
    const h = (await this.repo.get<{ purchases: Array<{ orderId: string; at: number; items: Array<{ productId: string; quantity: number }> }> }>(userId, NS.shoppingHistory, key)) ?? { purchases: [] };
    h.purchases.push({ orderId: order.id, at: order.placedAt, items: order.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
    await this.repo.put(userId, NS.shoppingHistory, key, h, `Shopping history: ${h.purchases.length} orders`);
  }

  /** Pull simulated delivery status; on delivery, record a confirmation and add items to the pantry. */
  async syncOrders(userId: string) {
    const changes: Array<{ orderId: string; status: string }> = [];
    for (const o of await this.repo.orders(userId)) {
      if (["delivered", "cancelled", "failed"].includes(o.status) || o.providerOrderId.startsWith("sbx_meal")) continue;
      const view = await this.env.adapters.grocery.getOrder(userId, o.providerOrderId);
      if (view.status === o.status) continue;
      const now = this.env.now();
      const updated: OrderRecord = { ...o, status: view.status, statusHistory: [...o.statusHistory, { at: now, status: view.status }] };
      if (view.status === "delivered") {
        updated.confirmationMessage = "Your grocery order was marked delivered by the sandbox simulator. No real delivery took place.";
        await resolveAdapter(this.env.adapters.voice, this.env.integrationMode).say(userId, "Your grocery order has arrived. (This is a simulated delivery.)", "grocery_delivered", o.id);
        await this.addDeliveredToPantry(userId, o);
      }
      await this.repo.saveOrder(userId, updated);
      changes.push({ orderId: o.id, status: view.status });
    }
    return changes;
  }

  private async addDeliveredToPantry(userId: string, o: OrderRecord) {
    const pantry = await this.repo.pantry(userId);
    for (const l of o.lines) {
      const p = await this.env.adapters.grocery.getProduct(userId, l.productId);
      if (!p || p.category === "household") continue;
      const existing = pantry.find((x) => x.productId === p.id);
      const now = this.env.now();
      await this.repo.savePantryItem(userId, existing
        ? { ...existing, quantity: existing.quantity + l.quantity, updatedAt: now }
        : {
            id: newId("pantry"),
            name: p.name,
            quantity: l.quantity,
            unit: "pack",
            expiresOn: null,
            ingredients: p.ingredients,
            allergens: p.allergens,
            allergenInfo: p.allergenInfo,
            tags: p.tags,
            productId: p.id,
            updatedAt: now,
            demo: o.demo,
          });
    }
  }
}
