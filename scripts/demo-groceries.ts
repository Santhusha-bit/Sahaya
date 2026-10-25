/**
 * Apify grocery demo: "Buy my usual groceries", then change the list and show
 * fresh product results. Uses a live Apify run when APIFY_TOKEN +
 * APIFY_GROCERY_ACTOR_ID are set (in the shell or .env.local), otherwise the
 * Actor's code locally against Open Prices.
 *
 *   npm run demo:groceries
 *   npm run demo:groceries -- "coffee, apples, butter"
 */
import { existsSync } from "node:fs";
import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { apifyStatus } from "@/lib/env";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const changed = (process.argv[2] ?? "coffee, gala apples, salted butter")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const status = apifyStatus();
console.log(`\n${status.label}: ${status.mode.toUpperCase()}\n  ${status.detail}\n`);

const service = new AgentService(createInMemoryDataLayer(), "margaret");
await service.initializeAll();

async function show(label: string, items?: string[]) {
  console.log(`== ${label} ==`);
  const t0 = Date.now();
  const d = await service.runTool("care", "discoverGroceryProducts", items ? { items } : {});
  const out = d.record.output as any;
  console.log(`  ${d.record.summary} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (out?.run) console.log(`  Apify run ${out.run.runId} ${out.run.status}: ${out.run.consoleUrl}`);
  for (const i of out?.items ?? []) {
    const o = i.options[0];
    const qty = i.quantity > 1 ? `${i.quantity} x ` : "";
    console.log(
      o
        ? `  - ${qty}${i.query}: ${o.name} $${o.price ?? "?"} @ ${o.retailer ?? "?"} (${o.availability})\n      ${o.sourceUrl}`
        : `  - ${qty}${i.query}: no products found`,
    );
  }
  const cart = await service.runTool("care", "prepareGroceryCart", { discoveryId: out.discoveryId });
  console.log(`  ${cart.record.summary}\n`);
  return cart.record.output as any;
}

await show('Margaret: "Buy my usual groceries"');
const cart = await show(`List changed: ${changed.join(", ")}`, changed);
if (cart?.approvalId) {
  const decided = await service.decideApproval("care", cart.approvalId, "approve");
  console.log(`Margaret approves -> ${decided.record?.summary}`);
}
