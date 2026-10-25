import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { shoppingIntent } from "@/agents/care/CareAgent";
import { demoOrderHistory, demoShoppingProfile, deriveUsualItems } from "@/agents/care/shopping/profile";
import { chooseProduct } from "@/agents/care/shopping/substitution";
import { SandboxProductSearch, ApifyProductSearch, normalizeApifyItem, searchItem } from "@/integrations/apify";
import type { CartLine, ShoppingCart } from "@/agents/care/shopping/types";

const USER = "demo-margaret";

async function setup() {
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const care = createAgent("care", { data, userId: USER });
  await care.initialize();
  return { data, service, care };
}

async function readyCart(care: ReturnType<typeof createAgent>) {
  const carts = await care.memory.list("carts", { tag: "shopping" });
  const rec = carts.find((c) => c.data.status === "ready")!;
  return { id: rec.id, cart: rec.data as unknown as ShoppingCart };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.APIFY_TOKEN;
  delete process.env.SHOP_TRACKING_STEP_MS;
});

describe("shopping history and preferences", () => {
  it("derives usual items from history (bought in at least half of past orders)", () => {
    const keys = deriveUsualItems(demoOrderHistory()).map((i) => i.key);
    expect(keys).toEqual(["milk", "bread", "eggs", "bananas", "oats", "soup", "yogurt"]);
    expect(keys).not.toContain("cookies"); // bought once in four orders
  });
});

describe("substitution policy (deterministic, code not prompt)", () => {
  const profile = demoShoppingProfile(USER);
  const item = (k: string) => profile.usualItems.find((i) => i.key === k)!;
  const search = new SandboxProductSearch();

  it("swaps out-of-stock usual milk for the closest acceptable 2% milk, never skim", async () => {
    const milk = item("milk");
    const line = chooseProduct(milk, await search.search({ query: milk.query, category: milk.category }), profile);
    expect(line.decision).toBe("substituted");
    expect(line.productName).toMatch(/Organic Valley/);
    expect(line.productName).not.toMatch(/skim/i);
    expect(line.reason).toMatch(/Clover is out of stock/);
    expect(line.unitPrice).toBeLessThanOrEqual(milk.usualPrice * 1.3);
  });

  it("keeps the low-sodium soup and never picks the cheaper high-sodium one", async () => {
    const soup = item("soup");
    const line = chooseProduct(soup, await search.search({ query: soup.query, category: soup.category }), profile);
    expect(line.decision).toBe("usual");
    expect(line.productName).toMatch(/Pacific Foods/);
    expect(line.quantity).toBe(2);
    expect(line.lineTotal).toBeCloseTo(7.98);
  });

  it("skips an item she asked never to substitute, and says why", async () => {
    const yogurt = item("yogurt");
    const line = chooseProduct(yogurt, await search.search({ query: yogurt.query, category: yogurt.category }), profile);
    expect(line.decision).toBe("skipped");
    expect(line.lineTotal).toBe(0);
    expect(line.reason).toMatch(/asked me not to swap/);
  });

  it("skips rather than buying a substitute far above her usual price", () => {
    const milk = item("milk");
    const line = chooseProduct(
      milk,
      [{ productId: "x", name: "Fancy 2% Milk", brand: "Fancy", price: 12.99, category: "dairy", tags: [], inStock: true, source: "sandbox" }],
      profile,
    );
    expect(line.decision).toBe("skipped");
    expect(line.reason).toMatch(/cost much more/);
  });
});

describe("voice -> cart -> approval -> sandbox checkout -> tracking", () => {
  it("runs the whole workflow, with approval bound to the exact cart", async () => {
    process.env.SHOP_TRACKING_STEP_MS = "1000";
    const { service, care } = await setup();

    const { reply } = await service.sendMessage("care", "I need my usual groceries", "voice");
    expect(reply.toolCalls.map((c) => c.toolName)).toEqual(["buildUsualCart"]);

    const { id: cartId, cart } = await readyCart(care);
    const byKey = Object.fromEntries(cart.lines.map((l: CartLine) => [l.itemKey, l.decision]));
    expect(byKey).toMatchObject({ milk: "substituted", soup: "usual", yogurt: "skipped", bananas: "usual" });
    expect(cart.subtotal).toBeCloseTo(33.03);
    expect(cart.deliveryFee).toBe(3.99);
    expect(cart.total).toBeCloseTo(37.02);

    // Exactly one pending approval, carrying the cart id, hash and total.
    const state = await service.agentState("care");
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0].input).toEqual({ cartId, cartHash: cart.cartHash, total: cart.total });
    expect(state.approvals[0].title).toBe("Buy 6 groceries for $37.02");
    expect(await care.memory.list("orders")).toHaveLength(0); // nothing bought yet

    const decision = await service.decideApproval("care", state.approvals[0].id, "approve");
    expect(decision.record?.status).toBe("success");
    expect(decision.record?.summary).toMatch(/sandbox checkout, no real payment/);
    const orders = await care.memory.list("orders");
    expect(orders).toHaveLength(1);
    expect(orders[0].data).toMatchObject({ total: 37.02, itemCount: 6, backend: "sandbox", status: "placed" });

    // Finance reviews the payment through the authorized bus (narrow payload).
    const evt = (await service.allEvents()).find((e) => e.type === "payment.review");
    expect(evt?.payload).toMatchObject({ amount: 37.02, itemCount: 6 });
    expect(evt?.payload).not.toHaveProperty("lines");

    // Tracking advances on the provider's timeline.
    const placedAt = Number(orders[0].data.placedAt);
    vi.useFakeTimers();
    vi.setSystemTime(placedAt + 2500);
    const mid = await care.executeTool("trackOrder", {});
    expect((mid.result.data as any).status).toBe("out_for_delivery");
    vi.setSystemTime(placedAt + 4500);
    const done = await care.executeTool("trackOrder", {});
    expect((done.result.data as any).status).toBe("delivered");
    const task = (await care.taskService.list()).find((t) => t.title.startsWith("Grocery order"));
    expect(task?.status).toBe("completed");
    expect(task?.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("a spoken 'yes' never approves a purchase", async () => {
    const { service, care } = await setup();
    await service.sendMessage("care", "I need my usual groceries", "voice");
    const { reply } = await service.sendMessage("care", "yes, buy it", "voice");
    expect(reply.text).toMatch(/tap the big green Approve button/);
    expect(await care.memory.list("orders")).toHaveLength(0);
    expect((await service.agentState("care")).approvals).toHaveLength(1);
  });

  it("'without eggs' leaves eggs out of the cart", async () => {
    expect(shoppingIntent("my usual groceries but no eggs please")).toEqual({ kind: "usual", exclude: ["eggs"] });
    const { service, care } = await setup();
    await service.sendMessage("care", "Order my usual groceries without eggs", "voice");
    const { cart } = await readyCart(care);
    expect(cart.lines.map((l: CartLine) => l.itemKey)).not.toContain("eggs");
  });
});

describe("checkout refuses anything the person did not approve", () => {
  it("refuses if the cart changed after approval was requested", async () => {
    const { service, care } = await setup();
    await service.sendMessage("care", "I need my usual groceries");
    const { id, cart } = await readyCart(care);
    // Tamper with a price behind the person's back.
    const lines = cart.lines.map((l: CartLine, i: number) => (i === 0 ? { ...l, unitPrice: l.unitPrice + 5, lineTotal: l.lineTotal + 5 } : l));
    await care.memory.update(id, { lines });
    const [approval] = (await service.agentState("care")).approvals;
    const res = await service.decideApproval("care", approval.id, "approve");
    expect(res.record?.status).toBe("error");
    expect(res.record?.error).toBe("cart_changed");
    expect(await care.memory.list("orders")).toHaveLength(0);
  });

  it("removing an item supersedes the old cart and its approval", async () => {
    const { service, care } = await setup();
    await service.sendMessage("care", "I need my usual groceries");
    const before = await readyCart(care);
    const [oldApproval] = (await service.agentState("care")).approvals;

    const { reply } = await service.sendMessage("care", "take off the eggs");
    expect(reply.toolCalls[0].toolName).toBe("removeCartItem");
    const after = await readyCart(care);
    expect(after.id).not.toBe(before.id);
    expect(after.cart.total).toBeCloseTo(before.cart.total - 6.49);

    const pending = (await service.agentState("care")).approvals;
    expect(pending).toHaveLength(1);
    expect((pending[0].input as any).cartId).toBe(after.id);
    expect((await care.approvalService.get(oldApproval.id))?.status).toBe("expired");

    // Even executing the old approval's input directly is refused.
    const stale = await care.executeTool("requestOrderApproval", oldApproval.input, { approved: true });
    expect(stale.result.error).toBe("cart_superseded");
  });

  it("never charges the same cart twice", async () => {
    const { service, care } = await setup();
    await service.sendMessage("care", "I need my usual groceries");
    const [approval] = (await service.agentState("care")).approvals;
    await service.decideApproval("care", approval.id, "approve");
    const again = await care.executeTool("requestOrderApproval", approval.input, { approved: true });
    expect(again.result.error).toBe("cart_already_ordered");
    expect(await care.memory.list("orders")).toHaveLength(1);
  });

  it("enforces the spending limit even after approval", async () => {
    const { service, care } = await setup();
    await service.sendMessage("care", "I need my usual groceries");
    const [profile] = await care.memory.list("shoppingProfile");
    await care.memory.update(profile.id, { spendingLimit: 20 });
    const [approval] = (await service.agentState("care")).approvals;
    const res = await service.decideApproval("care", approval.id, "approve");
    expect(res.record?.error).toBe("over_spending_limit");
    expect(await care.memory.list("orders")).toHaveLength(0);
  });
});

describe("Apify product search adapter", () => {
  it("normalizes varied Actor output shapes and derives dietary tags", () => {
    const a = normalizeApifyItem(
      { name: "Amy's Light in Sodium Lentil Vegetable Soup", offers: { price: "4.29", availability: "InStock" }, brand: { name: "Amy's" }, url: "https://x" },
      "pantry",
      0,
    );
    expect(a).toMatchObject({ name: expect.stringContaining("Amy's"), price: 4.29, brand: "Amy's", inStock: true, source: "apify" });
    expect(a?.tags).toContain("low-sodium");
    const b = normalizeApifyItem({ product: { title: "Fat Free Skim Milk", price: 3.5 }, availability: "OutOfStock" }, "dairy", 1);
    expect(b).toMatchObject({ price: 3.5, inStock: false });
    expect(b?.tags).toContain("skim");
    expect(normalizeApifyItem({ name: "No price" }, "dairy", 2)).toBeNull();
  });

  it("calls the run-sync dataset endpoint with a Bearer token and keyword input", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ name: "Clover 2% Milk", offers: { price: 5.59 } }]), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await new ApifyProductSearch("tok_123").search({ query: "2% milk", category: "dairy" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.apify\.com\/v2\/actors\/apify~e-commerce-scraping-tool\/run-sync-get-dataset-items/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_123");
    expect(JSON.parse(String(init.body))).toMatchObject({ keyword: "2% milk", maxProductResults: 8 });
    expect(out[0]).toMatchObject({ name: "Clover 2% Milk", price: 5.59, source: "apify" });
  });

  it("falls back to the sandbox catalog for an item when live search fails, and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("payment required", { status: 402 })));
    const res = await searchItem({ query: "bananas", category: "produce" }, new ApifyProductSearch("tok"));
    expect(res.backend).toBe("sandbox");
    expect(res.fallbackReason).toMatch(/402/);
    expect(res.candidates[0].source).toBe("sandbox");
  });
});
