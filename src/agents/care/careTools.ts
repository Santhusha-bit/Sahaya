import { z } from "zod";
import type { AgentTool } from "../base/types";
import { sendSms } from "@/integrations/twilio";
import { requestCareAssistance } from "@/integrations/fetchai";
import { createWorkItemStore } from "@/integrations/jira";
import { getPublicListingProvider, type ListingFetch } from "@/integrations/brightdata";
import { getDataLayer } from "../base/dataLayer";
import { cartHash } from "./shopping/cart";
import {
  buildUsualCart,
  checkoutCart,
  loadProfile,
  removeCartItem,
  requestCartApproval,
  trackLatestOrder,
} from "./shopping/service";
import { backendLabel, prepareCartFromDiscovery, runGroceryDiscovery, usualGroceries } from "./groceryWorkflow";
import { comparePrices, freshnessOf, type CandidateProduct, type PriceComparison } from "./priceCompare";
import { CATALOG } from "./catalog";
import { pantryTools } from "./pantryTools";
import { paidServiceTools } from "./paidServices/paidServiceTools";

/**
 * Resolve the person's on-file contact number for outbound Twilio notifications.
 * Reads shared household preferences (Care holds shared:read/write). Returns null
 * when none is on file, so sendSms honestly falls back to a sandbox result.
 */
async function recipientNumber(ctx: { memory: { readShared: (c: string, o?: { limit?: number }) => Promise<{ data: Record<string, unknown> }[]> } }): Promise<string | null> {
  try {
    const prefs = await ctx.memory.readShared("contact", { limit: 1 });
    const phone = prefs[0]?.data?.phone;
    return typeof phone === "string" && phone.trim() ? phone.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Structured product discovery: find the candidate product Care would normally buy.
 * Today this is the store catalog; it is the seam where Apify discovery plugs in.
 * Bright Data then verifies the candidate against the open market (comparePrices).
 */
function discoverCandidate(query: string, productId?: string): CandidateProduct | null {
  const terms = query.toLowerCase().split(/[,\s]+/).filter((t) => t && !/^\d+$/.test(t));
  const product =
    (productId && CATALOG.find((p) => p.id === productId)) ||
    CATALOG.find((p) => terms.some((t) => p.keywords.some((k) => k === t || k === t.replace(/s$/, "")) || p.name.toLowerCase().includes(t)));
  return product ? { id: product.id, name: product.name, price: product.price, source: "Sahaya Grocery catalog" } : null;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function perUnit(unitPrice: number | null, unitLabel: string | null): string {
  return unitPrice === null || !unitLabel ? "" : ` (${unitPrice < 0.1 ? `${(unitPrice * 100).toFixed(1)}¢` : money(unitPrice)}/${unitLabel})`;
}

export const careTools: AgentTool[] = [
  {
    name: "getMedicationSchedule",
    description: "Return the person's medication schedule and what is due today.",
    inputSchema: z.object({ when: z.enum(["today", "now", "all"]).default("today") }),
    async execute(_input, ctx) {
      const meds = await ctx.memory.list("medications");
      if (!meds.length) {
        return { ok: true, summary: "No medications are on file yet.", data: { medications: [] } };
      }
      const list = meds.map((m) => ({ id: m.id, name: m.data.name, dose: m.data.dose, time: m.data.time }));
      return { ok: true, summary: `${list.length} medication(s) on schedule.`, data: { medications: list } };
    },
  },
  {
    name: "sendMedicationReminder",
    description: "Send a reminder for a medication dose (via Twilio SMS when configured, otherwise recorded for in-app delivery).",
    inputSchema: z.object({ medicationName: z.string().min(1), time: z.string().optional() }),
    async execute(input, ctx) {
      const when = input.time ?? "now";
      // Twilio outbound notify (honest live/sandbox: real SMS only with creds + an
      // on-file number, otherwise a deterministic sandbox result).
      const to = await recipientNumber(ctx);
      const sms = await sendSms({
        to,
        body: `Reminder from Sahaya Care: time to take your ${input.medicationName}${when !== "now" ? ` (${when})` : ""}.`,
      }).catch(() => null);
      const rec = await ctx.memory.save("reminders", {
        medicationName: input.medicationName,
        time: when,
        sent: true,
        channel: sms?.backend === "twilio" && sms.sent ? "twilio_sms" : "in_app",
        smsSid: sms?.sid ?? null,
        smsSent: !!sms?.sent,
      });
      const via = sms?.backend === "twilio" && sms.sent ? " I texted it to your phone." : "";
      return {
        ok: true,
        summary: `Reminder sent for ${input.medicationName}.${via}`,
        data: { reminderId: rec.id, delivery: sms ? { backend: sms.backend, sent: sms.sent, reason: sms.reason } : null },
      };
    },
  },
  {
    name: "recordMedicationConfirmation",
    description: "Record that the person took (or skipped) a medication dose.",
    inputSchema: z.object({
      medicationName: z.string().min(1),
      taken: z.boolean(),
      note: z.string().optional(),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save(
        "confirmations",
        { medicationName: input.medicationName, taken: input.taken, note: input.note },
        { tags: ["medication", input.taken ? "taken" : "skipped"] },
      );
      // Medication adherence is sensitive health data: it stays in the canonical
      // Convex record only. Moss documents no encryption-at-rest or retention
      // guarantees, so it is never given medication information.
      return {
        ok: true,
        summary: input.taken
          ? `Logged ${input.medicationName} as taken. Nice work.`
          : `Noted ${input.medicationName} skipped — I'll check in later.`,
        data: { confirmationId: rec.id },
      };
    },
  },
  {
    name: "preparePharmacyRefill",
    description: "Prepare a pharmacy refill request for a medication running low.",
    inputSchema: z.object({ medicationName: z.string().min(1), pharmacy: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("refills", {
        medicationName: input.medicationName,
        pharmacy: input.pharmacy ?? "on-file pharmacy",
        status: "prepared",
      });
      await ctx.tasks.create({
        title: `Refill: ${input.medicationName}`,
        steps: ["Prepared", "Sent to pharmacy", "Ready for pickup"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      // Twilio outbound notify: let the person know the refill is on its way.
      const to = await recipientNumber(ctx);
      const sms = await sendSms({
        to,
        body: `Sahaya Care: your refill for ${input.medicationName} is being prepared at ${input.pharmacy ?? "your pharmacy"}. We'll let you know when it's ready.`,
      }).catch(() => null);
      const via = sms?.backend === "twilio" && sms.sent ? " I texted you a confirmation." : "";
      return {
        ok: true,
        summary: `Prepared a refill for ${input.medicationName}.${via}`,
        data: { refillId: rec.id, delivery: sms ? { backend: sms.backend, sent: sms.sent, reason: sms.reason } : null },
      };
    },
  },
  {
    name: "requestPickupHelp",
    description:
      "Ask Guardian to coordinate a person to physically collect a medication or refill the person cannot pick up themselves. An authorized cross-agent assistance request (carried over the Fetch.ai bridge when live).",
    inputSchema: z.object({
      need: z.string().min(1).describe("What help is needed, e.g. 'collect Metformin refill from the pharmacy'"),
      urgency: z.enum(["routine", "soon", "urgent"]).default("soon"),
    }),
    async execute(input, ctx) {
      const outcome = await requestCareAssistance({
        data: getDataLayer(),
        userId: ctx.userId,
        need: input.need,
        urgency: input.urgency,
        correlationId: ctx.correlationId,
      }).catch((err) => ({
        ok: false,
        backend: "sandbox" as const,
        taskId: "",
        userMessage: "I couldn't arrange that help just now, but we can try another way.",
        reason: err instanceof Error ? err.message : String(err),
      }));
      return {
        ok: outcome.ok,
        summary: outcome.userMessage,
        data: { backend: outcome.backend, taskId: outcome.taskId, reason: outcome.reason },
      };
    },
  },
  {
    name: "createGroceryList",
    description: "Create or append a grocery list from the items the person names.",
    inputSchema: z.object({ items: z.array(z.string().min(1)).min(1) }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("groceryLists", { items: input.items, status: "draft" }, { tags: ["grocery"] });
      return { ok: true, summary: `Grocery list created with ${input.items.length} item(s).`, data: { listId: rec.id, items: input.items } };
    },
  },
  {
    name: "searchProducts",
    description:
      "Search the small store catalog for ad-hoc items (use with createShoppingCart). For the person's usual groceries use buildUsualCart instead.",
    inputSchema: z.object({ query: z.string().min(1) }),
    async execute(input) {
      const terms = input.query.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const matches = CATALOG.filter((p) =>
        terms.some((t: string) => p.keywords.some((k) => k.includes(t) || t.includes(k)) || p.name.toLowerCase().includes(t)),
      );
      return {
        ok: true,
        summary: matches.length ? `Found ${matches.length} product(s).` : "No matching products found.",
        data: { products: matches },
      };
    },
  },
  {
    name: "discoverGroceryProducts",
    description:
      "Find fresh product names, prices, availability and source URLs for a shopping list by running the Apify Grocery Product Discovery Actor. Leave items empty to use the person's usual groceries. Returns a discoveryId for prepareGroceryCart.",
    inputSchema: z.object({
      items: z.array(z.string().min(1).max(80)).max(50).optional().describe("Shopping list entries, e.g. ['whole milk', '2 x eggs']"),
      retailer: z.string().max(60).optional().describe("Only consider stores whose name contains this, e.g. 'Walmart'"),
    }),
    async execute(input, ctx) {
      const items = input.items?.length ? input.items : await usualGroceries(ctx);
      const { discoveryId, discovery } = await runGroceryDiscovery(ctx, items, { retailer: input.retailer });
      const priced = discovery.items.filter((i) => i.status === "priced").length;
      const fallback = discovery.fallbackFrom ? ` (${discovery.fallbackFrom} was unavailable, so I used a fallback)` : "";
      return {
        ok: true,
        summary: `Checked ${discovery.items.length} item(s) using ${backendLabel(discovery)}${fallback}: ${priced} have current prices.`,
        data: {
          discoveryId,
          backend: discovery.backend,
          run: discovery.run,
          items: discovery.items.map((i) => ({
            query: i.query,
            quantity: i.quantity,
            status: i.status,
            priceRange: i.priceRange,
            options: discovery.offers
              .filter((o) => o.query.toLowerCase() === i.query.toLowerCase())
              .slice(0, 3)
              .map((o) => ({
                offerId: o.offerId,
                name: o.productName,
                brand: o.brand,
                size: o.size,
                price: o.price,
                currency: o.currency,
                pricePer: o.pricePer,
                retailer: o.retailer,
                storeLocation: o.storeLocation,
                availability: o.availability,
                priceObservedAt: o.priceObservedAt,
                sourceUrl: o.sourceUrl,
                imageUrl: o.imageUrl,
                matchScore: o.matchScore,
              })),
          })),
          warnings: discovery.warnings.slice(0, 5),
        },
      };
    },
  },
  {
    name: "prepareGroceryCart",
    description:
      "Compare the products from a discoverGroceryProducts run, pick the cheapest strong match per item, build the cart, and ask the person to approve it. Never purchases anything by itself.",
    inputSchema: z.object({ discoveryId: z.string().min(1) }),
    async execute(input, ctx) {
      const res = await prepareCartFromDiscovery(ctx, input.discoveryId, { requestApproval: true });
      if (!res.ok) {
        return {
          ok: false,
          summary:
            res.error === "no_priced_items"
              ? "I couldn't find current prices for any of those items."
              : "That product search has expired; let me search again.",
          error: res.error,
        };
      }
      const { plan } = res;
      const missing = plan.missing.length ? `; couldn't price ${plan.missing.map((m) => m.query).join(", ")}` : "";
      return {
        ok: true,
        summary: `Cart ready: ${plan.lines.length} item(s), $${plan.total.toFixed(2)}${missing}. Waiting for your approval.`,
        data: {
          cartId: res.cartId,
          approvalId: res.approvalId,
          total: plan.total,
          lines: plan.lines,
          missing: plan.missing,
          retailers: plan.retailers,
        },
      };
    },
  },
  {
    name: "updateUsualGroceries",
    description: "Save the person's usual grocery list (used when they say 'buy my usual groceries').",
    inputSchema: z.object({ items: z.array(z.string().min(1).max(80)).min(1).max(50) }),
    async execute(input, ctx) {
      await ctx.memory.writeShared("groceryPreferences", { usual: input.items });
      return { ok: true, summary: `Saved ${input.items.length} item(s) as your usual groceries.`, data: { usual: input.items } };
    },
  },
  {
    name: "createShoppingCart",
    description: "Assemble a shopping cart from product ids (and quantities) and compute the total.",
    inputSchema: z.object({
      items: z
        .array(z.object({ productId: z.string().min(1), quantity: z.number().int().positive().default(1) }))
        .min(1),
    }),
    async execute(input, ctx) {
      const lines = input.items.map((i: { productId: string; quantity: number }) => {
        const product = CATALOG.find((p) => p.id === i.productId);
        return {
          productId: i.productId,
          name: product?.name ?? i.productId,
          quantity: i.quantity,
          price: product?.price ?? 0,
          lineTotal: Number(((product?.price ?? 0) * i.quantity).toFixed(2)),
        };
      });
      const total = Number(lines.reduce((s: number, l: { lineTotal: number }) => s + l.lineTotal, 0).toFixed(2));
      const hash = cartHash(lines.map((l: { productId: string; quantity: number; price: number }) => ({ ...l, unitPrice: l.price })), total);
      const rec = await ctx.memory.save("carts", { lines, total, cartHash: hash, status: "ready" }, { tags: ["cart"] });
      return {
        ok: true,
        summary: `Cart ready: ${lines.length} item(s), total $${total.toFixed(2)}.`,
        data: { cartId: rec.id, cartHash: hash, lines, total },
      };
    },
  },
  {
    name: "getShoppingProfile",
    description:
      "Retrieve the person's shopping history and preferences: usual items (derived from past orders), preferred brands, dietary rules, spending limit and saved payment method label.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const { profile, history } = await loadProfile(ctx.memory);
      return {
        ok: true,
        summary: `${profile.usualItems.length} usual item(s) from ${history.length} past order(s); spending limit $${profile.spendingLimit}.`,
        data: {
          usualItems: profile.usualItems.map((i) => ({
            key: i.key,
            label: i.label,
            preferredBrand: i.preferredBrand,
            timesOrdered: i.timesOrdered,
            allowSubstitution: i.allowSubstitution,
          })),
          avoid: profile.avoidTags,
          dislikes: profile.dislikedTerms,
          spendingLimit: profile.spendingLimit,
          payment: profile.paymentMethod.label,
          recentOrders: history.slice(0, 3),
        },
      };
    },
  },
  {
    name: "buildUsualCart",
    description:
      "Build the person's usual grocery cart end to end: read history/preferences, search products (Apify when live), apply the substitution policy, compute a clear total, and (by default) request the person's approval for that exact cart. Use this when they ask for their usual groceries.",
    inputSchema: z.object({
      exclude: z.array(z.string()).optional().describe("Usual item keys to leave out, e.g. ['eggs']"),
      requestApproval: z.boolean().default(true),
    }),
    async execute(input, ctx) {
      const built = await buildUsualCart(ctx, { exclude: input.exclude });
      const approval = input.requestApproval ? await requestCartApproval(ctx, built) : null;
      const subs = built.cart.lines.filter((l) => l.decision === "substituted").length;
      const skips = built.cart.lines.filter((l) => l.decision === "skipped").length;
      return {
        ok: true,
        summary: `Cart ready: ${built.cart.lines.length - skips} item(s), total $${built.cart.total.toFixed(2)}${subs ? `, ${subs} substitution(s)` : ""}${skips ? `, ${skips} left off` : ""}.${approval ? " Waiting for your approval." : ""}`,
        approvalId: approval?.id,
        data: {
          cartId: built.cartId,
          cartHash: built.cart.cartHash,
          total: built.cart.total,
          deliveryFee: built.cart.deliveryFee,
          lines: built.cart.lines.map((l) => ({ item: l.label, decision: l.decision, product: l.productName, price: l.lineTotal, reason: l.reason })),
          searchBackend: built.searchBackend,
          spoken: built.spoken,
          approvalId: approval?.id ?? null,
        },
      };
    },
  },
  {
    name: "removeCartItem",
    description: "Remove one item from the current cart. This creates an updated cart with a new total and a fresh approval request.",
    inputSchema: z.object({ cartId: z.string().min(1), itemKey: z.string().min(1) }),
    async execute(input, ctx) {
      const built = await removeCartItem(ctx, input.cartId, input.itemKey);
      if (!built) return { ok: false, summary: "I couldn't change that cart (it may already be ordered).", error: "cart_not_editable" };
      const approval = await requestCartApproval(ctx, built);
      return {
        ok: true,
        summary: `Removed it. New total $${built.cart.total.toFixed(2)}.`,
        approvalId: approval.id,
        data: { cartId: built.cartId, cartHash: built.cart.cartHash, total: built.cart.total, approvalId: approval.id },
      };
    },
  },
  {
    name: "comparePrices",
    description:
      "Check the current public price of a grocery item. Finds the product Care would normally buy, then verifies its price against current public listings from other retailers (Bright Data when live, labeled sample listings in sandbox). Returns validated, size-normalized listings with source and freshness, a verification verdict, and a recommendation. Never buys anything.",
    inputSchema: z.object({
      query: z.string().min(1).max(80).describe("The item, e.g. 'milk' or '2% milk 1 gallon'"),
      productId: z.string().optional().describe("Catalog product id, if already known"),
    }),
    async execute(input, ctx) {
      const candidate = discoverCandidate(input.query, input.productId);
      if (!candidate) {
        return { ok: false, summary: `I couldn't find "${input.query}" in the store catalog to compare.`, error: "product_not_found" };
      }
      const provider = getPublicListingProvider();
      let fetched: ListingFetch;
      let fetchError: string | null = null;
      try {
        // Only the product name leaves Kinline, never the person's message.
        fetched = await provider.fetchListings(candidate.name);
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
        fetched = { backend: provider.backend, sourceLabel: "Bright Data (unreachable)", query: candidate.name, fetchedAt: Date.now(), listings: [], cached: false };
      }
      const comparison = comparePrices(candidate, fetched);
      const rec = await ctx.memory.save("priceChecks", { ...comparison, fetchError }, { tags: ["shopping", "price-check"] });

      const v = comparison.verification;
      const r = comparison.recommendation;
      const verdict =
        v.status === "verified"
          ? `Your usual ${money(candidate.price)} is in line with the market.`
          : v.status === "higher_than_market"
            ? `Your usual ${money(candidate.price)} is about ${Math.abs(v.candidateDeltaPct ?? 0)}% above the market.`
            : v.status === "lower_than_market"
              ? `Your usual ${money(candidate.price)} is about ${Math.abs(v.candidateDeltaPct ?? 0)}% below the market.`
              : `I couldn't verify the ${money(candidate.price)} price: ${v.note}`;
      const pick =
        r.choice === "candidate"
          ? "I'd stick with your usual product."
          : `Best value: ${r.merchant} at ${money(r.price)}${perUnit(r.unitPrice, r.unitLabel)}.`;
      const ignored = comparison.listings.filter((l) => l.outlier).length + comparison.rejected.length;
      const summary = fetchError
        ? `I couldn't reach the price service just now, so ${candidate.name} at ${money(candidate.price)} is unverified.`
        : `Checked ${candidate.name} against ${v.matchedCount} public listing(s) (${comparison.sourceLabel}, ${comparison.freshness.label}). ${verdict} ${pick}${ignored ? ` Ignored ${ignored} suspicious or invalid listing(s).` : ""}`;
      return { ok: !fetchError, summary, data: { comparisonId: rec.id, ...comparison, fetchError } };
    },
  },
  {
    name: "addToDraftCart",
    description:
      "Add a product from a price comparison to the person's DRAFT cart (defaults to the recommended choice). Nothing is purchased; use requestOrderApproval on the cart afterwards.",
    inputSchema: z.object({
      comparisonId: z.string().optional().describe("From comparePrices; defaults to the most recent comparison"),
      choice: z.string().default("recommended").describe("'recommended', 'candidate', or a listing id like 'l2'"),
      quantity: z.number().int().positive().max(20).default(1),
    }),
    async execute(input, ctx) {
      const rec = input.comparisonId
        ? await ctx.memory.get(input.comparisonId)
        : (await ctx.memory.list("priceChecks", { limit: 1 }))[0];
      if (!rec || rec.collection !== "priceChecks") {
        return { ok: false, summary: "I don't have a price comparison to add from. Let me check prices first.", error: "comparison_not_found" };
      }
      const cmp = rec.data as unknown as PriceComparison;
      if (freshnessOf(cmp.fetchedAt).stale) {
        return { ok: false, summary: "Those prices are over a day old. Let me check again before adding anything.", error: "stale_prices" };
      }
      const choice = input.choice === "recommended" ? cmp.recommendation.choice : input.choice;
      let line: Record<string, unknown>;
      if (choice === "candidate") {
        const c = cmp.candidate;
        line = { productId: c.id, name: c.name, merchant: c.source, price: c.price, source: c.source, link: null, fetchedAt: null };
      } else {
        const l = cmp.listings.find((x) => x.id === choice);
        if (!l) return { ok: false, summary: `I couldn't find option ${choice} in that comparison.`, error: "listing_not_found" };
        if (!l.matches || l.outlier || l.availability === "out_of_stock") {
          return { ok: false, summary: `I won't add ${l.merchant}'s listing: it's ${l.availability === "out_of_stock" ? "out of stock" : "not a trustworthy match"}.`, error: "listing_not_eligible" };
        }
        line = { productId: `${cmp.candidate.id}@${l.id}`, name: l.title, merchant: l.merchant, price: l.price, source: l.source, link: l.link, fetchedAt: l.fetchedAt };
      }
      const price = Number(line.price);
      line = { ...line, quantity: input.quantity, lineTotal: Number((price * input.quantity).toFixed(2)), comparisonId: rec.id };

      const draft = (await ctx.memory.list("carts", { tag: "cart" })).find((c) => c.data.status === "draft");
      const lines = [...(((draft?.data.lines as Record<string, unknown>[]) ?? []).filter((x) => x.productId !== line.productId)), line];
      const total = Number(lines.reduce((s, x) => s + Number(x.lineTotal ?? 0), 0).toFixed(2));
      const cart = draft
        ? await ctx.memory.update(draft.id, { lines, total, status: "draft" })
        : await ctx.memory.save("carts", { lines, total, status: "draft" }, { tags: ["cart"] });
      return {
        ok: true,
        summary: `Added ${line.name} from ${line.merchant} (${money(price)}${input.quantity > 1 ? ` x${input.quantity}` : ""}) to your draft cart. Cart total ${money(total)}. Nothing is bought until you approve the order.`,
        data: { cartId: cart?.id, lines, total, status: "draft" },
      };
    },
  },
  {
    name: "requestOrderApproval",
    description:
      "Request the person's approval to buy a cart, then check out. Required before any purchase. Pass the cartId, cartHash and total from the cart so the approval is bound to exactly what they saw. After approval the order is placed (sandbox checkout) and Finance reviews the payment.",
    inputSchema: z.object({
      cartId: z.string().min(1),
      cartHash: z.string().optional(),
      total: z.number().nonnegative().optional(),
    }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: input.total !== undefined ? `Buy groceries for $${input.total.toFixed(2)}` : "Place grocery order",
      description: `Care wants to place the order for this cart${input.total !== undefined ? ` ($${input.total.toFixed(2)})` : ""}. Approve to purchase.`,
    }),
    async execute(input, ctx) {
      // Approval alone is not enough: checkout re-verifies in code that the cart
      // is unchanged, not already ordered, and within the spending limit.
      const placed = await checkoutCart(ctx, input);
      if (!placed.ok) return { ok: false, summary: placed.message, error: placed.refusal };
      const { orderId, total, itemCount } = placed;
      const task = await ctx.tasks.create({
        title: `Grocery order ($${total.toFixed(2)})`,
        steps: ["Approved", "Placed", "Packed", "Out for delivery", "Delivered"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      await ctx.tasks.advanceStep(task.id, "Approved", "done");
      await ctx.tasks.advanceStep(task.id, "Placed", "done", placed.placed.orderRef);
      await ctx.memory.update(orderId, { taskId: task.id });
      // Atlassian Jira (controlled action review): mirror the placed order to the
      // work-item store so caregivers have a reviewable record. Live with ATLASSIAN_*
      // credentials (a Jira issue is created); otherwise the same reviewable sandbox
      // store. Best-effort: a Jira failure never blocks the order the person approved.
      let reviewBackend: string | null = null;
      let reviewItemId: string | null = null;
      try {
        const { service, backend } = createWorkItemStore();
        const item = await service.propose({
          userId: ctx.userId,
          requestedAction: `Grocery order placed: ${itemCount} item(s), $${total.toFixed(2)}`,
          toolName: "requestOrderApproval",
          requestingAgent: "care",
          assignedAgent: "care",
          permissionScope: "care:order",
          input: { cartId: input.cartId, orderId, total },
        });
        reviewBackend = backend;
        reviewItemId = item.id;
      } catch {
        /* non-fatal: the order is already placed and recorded canonically */
      }
      // Authorized cross-agent request: ask Finance to review the payment.
      const review = await ctx.bus.publish({
        sourceAgent: "care",
        targetAgent: "finance",
        type: "payment.review",
        userId: ctx.userId,
        correlationId: ctx.correlationId,
        payload: { orderId, amount: total, merchant: "Sahaya Grocery (sandbox)", itemCount },
      });
      return {
        ok: true,
        summary: `Order placed for $${total.toFixed(2)} (sandbox checkout, no real payment). Order ${placed.placed.orderRef}.${review.ok ? " Finance will review the payment." : ""}`,
        data: {
          orderId,
          orderRef: placed.placed.orderRef,
          checkout: placed.placed.backend,
          notice: placed.placed.notice,
          financeReview: review.ok,
          review: reviewItemId ? { backend: reviewBackend, itemId: reviewItemId } : null,
        },
      };
    },
  },
  {
    name: "trackOrder",
    description: "Check the delivery status of the person's most recent grocery order (or a given orderId).",
    inputSchema: z.object({ orderId: z.string().optional() }),
    async execute(input, ctx) {
      const t = await trackLatestOrder(ctx, input.orderId);
      if (!t) return { ok: true, summary: "You don't have any grocery orders yet.", data: { order: null } };
      const taskId = typeof t.order.taskId === "string" ? t.order.taskId : null;
      if (taskId) {
        const labels: Record<string, string> = { packed: "Packed", out_for_delivery: "Out for delivery", delivered: "Delivered" };
        for (const s of t.steps) if (s.done && labels[s.stage]) await ctx.tasks.advanceStep(taskId, labels[s.stage], "done");
        if (t.current.stage === "delivered") await ctx.tasks.setStatus(taskId, "completed", "Delivered");
      }
      return {
        ok: true,
        summary: `Your order is: ${t.current.label.toLowerCase()}.`,
        data: { orderId: t.orderId, orderRef: t.order.orderRef, status: t.current.stage, steps: t.steps },
      };
    },
  },
  {
    name: "suggestMeals",
    description: "Suggest simple meals based on the pantry and any dietary preferences.",
    inputSchema: z.object({
      preference: z.string().optional().describe("e.g. 'low sodium', 'soft foods', 'vegetarian'"),
      count: z.number().int().min(1).max(5).default(3),
    }),
    async execute(input, ctx) {
      const pantry = await ctx.memory.list("pantry");
      const have = pantry.map((p) => String(p.data.item ?? "").toLowerCase());
      const ideas = [
        { name: "Oatmeal with banana", needs: ["oats", "banana"] },
        { name: "Chicken & brown rice bowl", needs: ["chicken", "rice"] },
        { name: "Greek yogurt with apple", needs: ["yogurt", "apple"] },
        { name: "Vegetable soup with bread", needs: ["soup", "bread"] },
        { name: "Scrambled eggs on toast", needs: ["eggs", "bread"] },
      ];
      const ranked = ideas
        .map((i) => ({ ...i, ready: i.needs.every((n) => have.some((h) => h.includes(n))) }))
        .sort((a, b) => Number(b.ready) - Number(a.ready))
        .slice(0, input.count);
      return {
        ok: true,
        summary: `${ranked.length} meal idea(s)${input.preference ? ` (${input.preference})` : ""}.`,
        data: { meals: ranked },
      };
    },
  },
  {
    name: "updatePantry",
    description: "Add or update items in the pantry inventory.",
    inputSchema: z.object({ items: z.array(z.string().min(1)).min(1) }),
    async execute(input, ctx) {
      for (const item of input.items) {
        await ctx.memory.save("pantry", { item }, { tags: ["pantry"] });
      }
      return { ok: true, summary: `Pantry updated with ${input.items.length} item(s).`, data: { added: input.items } };
    },
  },
  ...pantryTools,
  ...paidServiceTools,
];
