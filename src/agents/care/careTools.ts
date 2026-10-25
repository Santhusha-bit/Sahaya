import { z } from "zod";
import type { AgentTool } from "../base/types";
import { sendSms } from "@/integrations/twilio";
import { getPersonalMemoryProvider } from "@/integrations/moss";
import { requestCareAssistance } from "@/integrations/fetchai";
import { createWorkItemStore } from "@/integrations/jira";
import { getPublicListingProvider, type ListingFetch } from "@/integrations/brightdata";
import { getDataLayer } from "../base/dataLayer";
import { comparePrices, freshnessOf, type CandidateProduct, type PriceComparison } from "./priceCompare";

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

/** Tiny stubbed product catalog so searchProducts returns real, priced results. */
const CATALOG: { id: string; name: string; price: number; keywords: string[] }[] = [
  { id: "p_milk", name: "2% Milk, 1 gal", price: 3.79, keywords: ["milk", "dairy"] },
  { id: "p_bread", name: "Whole Wheat Bread", price: 2.99, keywords: ["bread", "wheat"] },
  { id: "p_eggs", name: "Large Eggs, dozen", price: 4.29, keywords: ["egg", "eggs"] },
  { id: "p_bananas", name: "Bananas, bunch", price: 1.89, keywords: ["banana", "fruit"] },
  { id: "p_oats", name: "Rolled Oats, 18oz", price: 3.49, keywords: ["oats", "oatmeal", "breakfast"] },
  { id: "p_chicken", name: "Chicken Breast, 1 lb", price: 5.99, keywords: ["chicken", "meat", "protein"] },
  { id: "p_rice", name: "Brown Rice, 2 lb", price: 2.69, keywords: ["rice", "grain"] },
  { id: "p_soup", name: "Low-Sodium Veg Soup", price: 2.19, keywords: ["soup", "canned", "vegetable"] },
  { id: "p_yogurt", name: "Greek Yogurt, 4-pack", price: 4.49, keywords: ["yogurt", "dairy", "protein"] },
  { id: "p_apples", name: "Apples, 3 lb bag", price: 4.99, keywords: ["apple", "fruit"] },
];

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
      // Moss personal memory: keep a small, durable adherence note so Care stays
      // personal across conversations. Supplementary only — a Moss failure never
      // corrupts the canonical Convex/scoped record above.
      let continuityBackend: string | null = null;
      try {
        const moss = getPersonalMemoryProvider();
        await moss.save({
          userId: ctx.userId,
          kind: "note",
          text: `medication ${input.taken ? "taken" : "skipped"}: ${input.medicationName}${input.note ? ` (${input.note})` : ""}`,
        });
        continuityBackend = moss.backend;
      } catch {
        /* non-fatal: canonical record is already saved */
      }
      return {
        ok: true,
        summary: input.taken
          ? `Logged ${input.medicationName} as taken. Nice work.`
          : `Noted ${input.medicationName} skipped — I'll check in later.`,
        data: { confirmationId: rec.id, continuity: continuityBackend },
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
      // Moss personal memory: remember what the person likes to buy so Care's
      // suggestions stay personal over time. Supplementary, non-fatal on failure.
      try {
        const moss = getPersonalMemoryProvider();
        await moss.save({ userId: ctx.userId, kind: "preference", text: `groceries: ${input.items.join(", ")}` });
      } catch {
        /* non-fatal: canonical list is already saved */
      }
      return { ok: true, summary: `Grocery list created with ${input.items.length} item(s).`, data: { listId: rec.id, items: input.items } };
    },
  },
  {
    name: "searchProducts",
    description: "Search the store catalog for products matching a query or list of item names.",
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
      const rec = await ctx.memory.save("carts", { lines, total, status: "ready" }, { tags: ["cart"] });
      return {
        ok: true,
        summary: `Cart ready: ${lines.length} item(s), total $${total.toFixed(2)}.`,
        data: { cartId: rec.id, lines, total },
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
      "Request the person's approval to place a grocery order for a cart. Required before any purchase. After approval the order is placed and (if enabled) sent to Finance for a payment review.",
    inputSchema: z.object({ cartId: z.string().min(1) }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: "Place grocery order",
      description: `Care wants to place the order for cart ${input.cartId}. Approve to purchase.`,
    }),
    async execute(input, ctx) {
      const cart = await ctx.memory.get(input.cartId);
      if (!cart) return { ok: false, summary: "That cart no longer exists.", error: "cart_not_found" };
      const total = Number(cart.data.total ?? 0);
      const lines = (cart.data.lines as unknown[]) ?? [];
      const order = await ctx.memory.save(
        "orders",
        { cartId: input.cartId, total, itemCount: lines.length, status: "placed" },
        { tags: ["order"] },
      );
      await ctx.tasks.create({
        title: `Grocery order ($${total.toFixed(2)})`,
        steps: ["Approved", "Placed", "Out for delivery", "Delivered"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      // Atlassian Jira (controlled action review): mirror the placed order to the
      // work-item store so caregivers have a reviewable record. Live with ATLASSIAN_*
      // credentials (a Jira issue is created); otherwise the same reviewable sandbox
      // store. Best-effort — a Jira failure never blocks the order the person approved.
      let reviewBackend: string | null = null;
      let reviewItemId: string | null = null;
      try {
        const { service, backend } = createWorkItemStore();
        const item = await service.propose({
          userId: ctx.userId,
          requestedAction: `Grocery order placed: ${lines.length} item(s), $${total.toFixed(2)}`,
          toolName: "requestOrderApproval",
          requestingAgent: "care",
          assignedAgent: "care",
          permissionScope: "care:order",
          requiredRole: "caregiver",
          input: { cartId: input.cartId, orderId: order.id, total },
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
        payload: { orderId: order.id, amount: total, merchant: "Sahaya Grocery", itemCount: lines.length },
      });
      return {
        ok: true,
        summary: `Order placed for $${total.toFixed(2)}.${review.ok ? " Finance will review the payment." : ""}`,
        data: { orderId: order.id, financeReview: review.ok, review: reviewItemId ? { backend: reviewBackend, itemId: reviewItemId } : null },
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
];
