import { z } from "zod";
import type { AgentTool } from "../base/types";

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
    description: "Send a reminder for a medication dose.",
    inputSchema: z.object({ medicationName: z.string().min(1), time: z.string().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("reminders", {
        medicationName: input.medicationName,
        time: input.time ?? "now",
        sent: true,
      });
      return { ok: true, summary: `Reminder sent for ${input.medicationName}.`, data: { reminderId: rec.id } };
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
      return { ok: true, summary: `Prepared a refill for ${input.medicationName}.`, data: { refillId: rec.id } };
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
      // Authorized cross-agent request: ask Finance to review the payment.
      const review = await ctx.bus.publish({
        sourceAgent: "care",
        targetAgent: "finance",
        type: "payment.review",
        userId: ctx.userId,
        correlationId: ctx.correlationId,
        payload: { orderId: order.id, amount: total, merchant: "Kinline Grocery", itemCount: lines.length },
      });
      return {
        ok: true,
        summary: `Order placed for $${total.toFixed(2)}.${review.ok ? " Finance will review the payment." : ""}`,
        data: { orderId: order.id, financeReview: review.ok },
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
