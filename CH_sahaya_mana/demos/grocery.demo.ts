import { expect, it } from "vitest";
import { interpretGroceryRequest } from "@/agents/care/domain/language";
import type { OrderSummary } from "@/agents/care/services/groceryService";
import { catalogById } from "@/agents/care/data/catalog";
import { sanitizeUntrusted } from "@/agents/care/domain/untrusted";
import { daughter, demoWorld, margaret, say } from "./demoWorld";

it("Demo B — personalized grocery order", async () => {
  const w = await demoWorld();
  const run = async (tool: string, input: unknown, ctx = margaret) => {
    say.intent(tool, input);
    return w.care.executeTool(ctx, tool, input);
  };

  say.title("Demo B — Margaret's usual groceries, safely");
  say.info("Profile: peanut allergy · prefers low-sodium groceries and oat milk · limits $120/order, $200/week");
  say.clock(w.clock.now());

  say.step(1, "Margaret asks for her usual groceries");
  const request = "I'm running out of groceries. Can you get me what I usually buy?";
  say.user("Margaret", request);
  const intent = interpretGroceryRequest(request);
  expect(intent).toMatchObject({ usual: true, runningLow: true });

  say.step(2, "Care prepares a personalized cart from her purchase history and preferences");
  const built = await run("createGroceryList", { includeUsualItems: true, additionalItems: intent.items });
  if (built.status !== "success") throw new Error(JSON.stringify(built));
  let summary = built.output as OrderSummary;
  for (const l of summary.lines) say.info(`• ${l.quantity} × ${l.name} — ${l.lineTotal}`);

  say.step(3, "A missing household essential is found and offered — not added");
  const add = summary.pendingAdditions[0];
  expect(add.name).toBe("Dish Soap");
  say.care(`${add.reason} Would you like me to add ${add.name}?`);
  say.user("Margaret", "Yes, please add it.");
  await run("respondToCartSuggestion", { cartId: summary.cartId, suggestionId: add.id, decision: "accept" });
  say.ok("Dish Soap added after her yes");

  say.step(4, "Her usual oat milk is out of stock, so Care suggests a substitute");
  const sub = summary.pendingSubstitutions[0];
  expect(sub.original.productId).toBe("p_oat_oatfield");
  say.care(sub.reason);
  say.info("The substitute passed the same allergy and diet filter; it is NOT in the cart until she agrees.");

  say.step(5, "An untrusted suggestion proposes a peanut product — the filter blocks it");
  const bar = catalogById("p_protein_bar")!;
  const desc = sanitizeUntrusted(bar.description, "catalog");
  say.info(`Catalog listing for “${bar.name}” says: “${desc.text}”`);
  say.warn(`Description flagged as possible instructions: ${desc.flagged} (treated as data, never obeyed)`);
  const attempt = await run("createShoppingCart", { cartId: summary.cartId, items: [{ productId: bar.id, quantity: 2 }] });
  const blocked = (attempt as { output: { blocked: Array<{ name: string; reasons: string[] }>; added: string[] } }).output;
  expect(blocked.added).toEqual([]);
  say.blocked(`${blocked.blocked[0].name}: ${blocked.blocked[0].reasons.join(", ")} — not added`);

  say.step(6, "Margaret reviews the cart and agrees to the substitution");
  say.user("Margaret", "The Meadow Mill oat milk is fine.");
  const subRes = await run("respondToCartSuggestion", { cartId: summary.cartId, suggestionId: sub.id, decision: "accept", original: sub.original.name, substitute: sub.substitute.name });
  expect(subRes.status).toBe("approval_required");
  if (subRes.status === "approval_required") {
    say.info(`Approval card: “${subRes.approval.summary}”`);
    await w.runtime.resolveApproval(margaret, subRes.approval.id, "approve");
    say.ok("Margaret approved the substitution in the app");
  }
  const review = await run("reviewCart", { cartId: summary.cartId });
  summary = (review as { output: OrderSummary }).output;
  for (const line of summary.plainText.split("\n")) say.info(line);
  expect(summary.readyForApproval).toBe(true);
  say.ok(`Within limits: ${summary.spending.ok} (week so far $${(summary.spending.weekSpentCents / 100).toFixed(2)})`);

  say.step(7, "Care asks for order approval; her daughter approves it");
  const req = await run("requestOrderApproval", { cartId: summary.cartId, cartHash: summary.cartHash, totalCents: summary.totals.totalCents, deliveryWindowId: summary.deliveryWindow!.id });
  expect(req.status).toBe("approval_required");
  if (req.status !== "approval_required") return;
  say.info(`Approval card for Ellen: “${req.approval.summary}”`);
  const decided = await w.care.decide(daughter, req.approval.id, "approve");
  expect(decided.result).toMatchObject({ status: "success", output: { status: "placed", simulated: true } });

  say.step(8, "The sandbox grocery adapter places the simulated order");
  const out = (decided.result as { output: { orderId: string; total: string; note: string; deliveryWindow: string } }).output;
  say.ok(`Order ${out.orderId}: ${out.total}, ${out.deliveryWindow}`);
  say.info(out.note);

  say.step(9, "Delivery status moves through the sandbox lifecycle");
  for (const minutes of [20, 24 * 60 + 55, 60]) {
    w.clock.advanceMinutes(minutes);
    await w.care.tick(margaret);
    const [o] = await w.services().env.repo.orders(margaret.userId);
    say.info(`${new Date(w.clock.now()).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" })} → ${o.status}`);
  }
  const [order] = await w.services().env.repo.orders(margaret.userId);
  expect(order.status).toBe("delivered");
  say.care("Your grocery order has arrived. (This is a simulated delivery.)");

  say.step(10, "The dashboard shows the current order status");
  const view = await w.care.getDashboard(daughter);
  const g = view.grocery as { orders: Array<{ orderId: string; status: string; total: string; confirmation: string | null }> };
  for (const o of g.orders) say.info(`Order ${o.orderId}: ${o.status}, ${o.total} — ${o.confirmation}`);
  expect(g.orders[0].status).toBe("delivered");
  say.ok("Done. No real purchase, payment or delivery happened.");
});
