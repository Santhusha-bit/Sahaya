/**
 * Demo: compare the same grocery item across multiple public listings.
 *
 *   npm run demo:prices            # sandbox sample listings (no key needed)
 *   npm run demo:prices -- eggs    # another item
 *
 * With BRIGHTDATA_API_TOKEN + BRIGHTDATA_SERP_ZONE set, listings come live from
 * Google Shopping via the Bright Data SERP API.
 */

import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import type { PriceComparison } from "@/agents/care/priceCompare";
import { brightDataStatus } from "@/lib/env";

const item = process.argv[2] ?? "milk";

function unit(p: number | null, label: string | null): string {
  return p === null || !label ? "" : `${(p * 100).toFixed(2)}¢/${label}`;
}

async function main() {
  const status = brightDataStatus();
  console.log(`\nBright Data: ${status.mode.toUpperCase()}. ${status.detail}\n`);

  const care = createAgent("care", { data: createInMemoryDataLayer(), userId: "demo-prices" });
  await care.initialize();

  const { result } = await care.executeTool("comparePrices", { query: item });
  console.log(`Care: ${result.summary}\n`);
  const cmp = result.data as PriceComparison & { comparisonId: string };
  if (!cmp?.listings) return;

  console.log(`Usual product: ${cmp.candidate.name}  $${cmp.candidate.price.toFixed(2)}  ${unit(cmp.candidate.unitPrice, cmp.candidate.unitLabel)}  [${cmp.candidate.source}]`);
  console.log(`Source: ${cmp.sourceLabel}, fetched ${cmp.freshness.label}${cmp.cached ? " (cached)" : ""}\n`);
  console.table(
    cmp.listings.map((l) => ({
      id: l.id,
      merchant: l.merchant,
      size: l.size?.label ?? "?",
      price: `$${l.price.toFixed(2)}`,
      unit: unit(l.unitPrice, l.unitLabel),
      stock: l.availability,
      flag: l.outlier ? "suspicious price" : !l.matches ? "not comparable" : "",
    })),
  );
  for (const r of cmp.rejected) console.log(`  dropped by validation (${r.reason}): ${r.title}`);
  console.log(`\nVerification: ${cmp.verification.status}. ${cmp.verification.note}`);
  console.log(`Recommendation: ${cmp.recommendation.choice === "candidate" ? "keep usual product" : `${cmp.recommendation.merchant} $${cmp.recommendation.price.toFixed(2)}`}. ${cmp.recommendation.reason}\n`);

  const add = await care.executeTool("addToDraftCart", { comparisonId: cmp.comparisonId });
  console.log(`Care: ${add.result.summary}`);
  const cartId = (add.result.data as { cartId?: string } | undefined)?.cartId;
  if (cartId) {
    const order = await care.executeTool("requestOrderApproval", { cartId });
    console.log(`Order status: ${order.record.status} (purchase waits for the person's approval)\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
