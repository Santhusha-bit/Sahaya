/**
 * npm run demo:shopping
 *
 * Visa "Reimagining shopping": Margaret asks for her usual groceries by voice.
 * Care retrieves her history + preferences, searches products (Apify when
 * APIFY_TOKEN is set, else the sandbox catalog), chooses substitutions with the
 * deterministic policy, shows an accessible cart with a clear total, waits for
 * her approval, checks out (sandbox: no real payment), and tracks the order.
 */

import { apifyStatus, checkoutStatus } from "@/lib/env";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import type { CartLine, ShoppingCart } from "@/agents/care/shopping/types";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  process.env.SHOP_TRACKING_STEP_MS ??= "400";
  const USER = "demo-margaret";
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const care = createAgent("care", { data, userId: USER });
  await care.initialize();

  line("═");
  console.log("SAHAYA: accessible voice shopping demo (Visa track)");
  console.log(`Apify:    ${apifyStatus().mode}. ${apifyStatus().detail}`);
  console.log(`Checkout: ${checkoutStatus().mode}. ${checkoutStatus().detail}`);
  line("═");

  console.log(`\n1. Margaret (voice): "I need my usual groceries"`);
  const { reply } = await service.sendMessage("care", "I need my usual groceries", "voice");
  console.log(`   Care: ${reply.text.split("\n\n")[0]}`);

  const profile = await care.executeTool("getShoppingProfile", {});
  console.log(`\n2. History + preferences: ${profile.result.summary}`);

  const rec = (await care.memory.list("carts", { tag: "shopping" })).find((c) => c.data.status === "ready")!;
  const cart = rec.data as unknown as ShoppingCart & { searchBackend: string };
  console.log(`\n3-5. Cart (prices from ${cart.searchBackend} search):`);
  for (const l of cart.lines as CartLine[]) {
    const tag = l.decision === "usual" ? "usual  " : l.decision === "substituted" ? "SWAPPED" : "LEFT OFF";
    const price = l.decision === "skipped" ? "" : `$${l.lineTotal.toFixed(2)}`;
    console.log(`   [${tag}] ${l.label.padEnd(28)} ${price.padStart(7)}  ${l.productName ?? ""}`);
    if (l.decision !== "usual") console.log(`             ${l.reason}`);
  }
  console.log(`   Subtotal $${cart.subtotal.toFixed(2)}  Delivery $${cart.deliveryFee.toFixed(2)}  TOTAL $${cart.total.toFixed(2)}`);

  const [approval] = (await service.agentState("care")).approvals;
  console.log(`\n6. Approval card: "${approval.title}". ${approval.description}`);
  console.log(`   Orders before approval: ${(await care.memory.list("orders")).length}`);
  console.log(`   Margaret says "yes buy it" out loud...`);
  const yes = await service.sendMessage("care", "yes buy it", "voice");
  console.log(`   Care: ${yes.reply.text}`);
  console.log(`   Margaret taps "Approve and pay $${cart.total.toFixed(2)}".`);
  const decision = await service.decideApproval("care", approval.id, "approve");
  console.log(`\n7. Checkout: ${decision.record?.summary}`);
  const finance = (await service.agentState("finance")).tasks.find((t) => t.title.startsWith("Payment review"));
  console.log(`   Finance: ${finance ? finance.title : "no review task"}`);

  console.log(`\n8. Tracking:`);
  for (let i = 0; i < 8; i++) {
    const t = await care.executeTool("trackOrder", {});
    console.log(`   ${t.result.summary}`);
    if ((t.result.data as { status?: string }).status === "delivered") break;
    await new Promise((r) => setTimeout(r, Number(process.env.SHOP_TRACKING_STEP_MS) * 1.1));
  }
  line("═");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
