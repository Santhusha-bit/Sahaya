/**
 * npm run demo:nessie
 *
 * Capital One Nessie track: Finance reviews Margaret's sandbox checking account.
 *  1. Margaret asks Finance about her subscriptions; Finance asks for read access.
 *  2. She approves; Finance sets up the Nessie customer + account + test purchases.
 *  3. Finance pulls the authorized purchases, Claude categorizes them (rules
 *     without ANTHROPIC_API_KEY), code finds duplicates/subscriptions, and
 *     Finance prepares the monthly summary + suggested actions (saved to Convex
 *     when NEXT_PUBLIC_CONVEX_URL is set).
 *  4. The bank posts a new purchase (a double charge); the next analysis flags it.
 *  5. Margaret accepts the dispute suggestion: Finance drafts it, sends nothing.
 *
 * Live Nessie with NESSIE_API_KEY; otherwise the local Nessie emulator.
 */

import { claudeStatus, convexStatus, nessieStatus } from "@/lib/env";
import { getDataLayer } from "@/agents/base/dataLayer";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getNessieClient } from "@/integrations/nessie";
import { currentSuggestions, latestAnalysis, simulateNewPurchase } from "@/agents/finance/nessie/service";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  const USER = `demo-margaret-${Date.now().toString(36)}`;
  const data = getDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const finance = createAgent("finance", { data, userId: USER });
  await finance.initialize();

  line("═");
  console.log("KINLINE: Finance + Capital One Nessie demo");
  for (const s of [nessieStatus(), claudeStatus(), convexStatus()]) console.log(`${s.label}: ${s.mode}. ${s.detail}`);
  line("═");

  console.log(`\n1. Margaret: "What subscriptions am I paying for?"`);
  const ask = await service.sendMessage("finance", "What subscriptions am I paying for?");
  console.log(`   Finance: ${ask.reply.text.split("\n\n")[0]}`);
  const [approval] = (await service.agentState("finance")).approvals;
  console.log(`   Approval card: "${approval.title}"`);

  console.log(`\n2. Margaret taps Allow.`);
  const ok = await service.decideApproval("finance", approval.id, "approve");
  console.log(`   ${ok.record?.summary}`);

  console.log(`\n3. Margaret asks again; Finance runs its spending review.`);
  await service.sendMessage("finance", "What subscriptions am I paying for?");
  const a1 = (await latestAnalysis(finance.memory))!;
  console.log(`   Categorized by: ${a1.reviewer}${a1.reviewerNote ? ` (${a1.reviewerNote})` : ""}`);
  console.log(`   ${a1.month}: $${a1.summary.total.toFixed(2)} across ${a1.summary.transactionCount} purchases (last month $${a1.summary.previousTotal.toFixed(2)})`);
  for (const c of a1.summary.byCategory) console.log(`     ${c.label.padEnd(28)} $${c.total.toFixed(2).padStart(7)}   (was $${c.previousTotal.toFixed(2)})`);
  console.log(`   Subscriptions ($${a1.summary.recurringMonthlyTotal.toFixed(2)}/month):`);
  for (const s of a1.subscriptions) console.log(`     ${s.merchant.padEnd(20)} $${s.monthlyAmount.toFixed(2)}${s.priceIncrease ? `  UP from $${s.previousAmount.toFixed(2)}` : ""}${s.note ? `  "${s.note}"` : ""}`);
  console.log(`   Possible duplicates: ${a1.duplicates.length}`);
  console.log(`   Finance says: ${a1.spoken}`);
  console.log(`   Suggestions:`);
  for (const s of await currentSuggestions(finance.memory)) console.log(`     [${s.status}] ${s.title}`);

  console.log(`\n4. DEMO: the bank posts a new purchase to the sandbox account...`);
  const sim = await simulateNewPurchase({ memory: finance.memory, nessie: getNessieClient() }, { scenario: "double_charge" });
  console.log(`   Posted: ${sim.merchant} $${sim.purchase.amount.toFixed(2)} on ${sim.purchase.purchase_date}`);
  const again = await service.sendMessage("finance", "Any new charges on my account?");
  console.log(`   Finance: ${again.reply.toolCalls[0]?.summary ?? again.reply.text}`);
  const a2 = (await latestAnalysis(finance.memory))!;
  for (const t of a2.newTransactions) console.log(`   NEW: ${t.merchant} $${t.amount.toFixed(2)} ${t.date} [${t.flags.join(", ") || "no flags"}]`);

  console.log(`\n5. Margaret accepts the double-charge suggestion.`);
  const dup = (await currentSuggestions(finance.memory)).find((s) => s.kind === "dispute_duplicate");
  if (dup) {
    const { record } = await service.runTool("finance", "reviewSuggestedAction", { actionId: dup.id, decision: "accept" });
    console.log(`   Finance: ${record.summary}`);
  }
  console.log(`\nSaved in Finance's memory (${data.backend === "convex" ? "Convex" : "in-process store"}): ${(await finance.memory.list("spendingAnalyses")).length} analyses, ${(await finance.memory.list("suggestedActions")).length} suggestions, ${(await finance.memory.list("disputes")).length} drafted dispute(s).`);
  line("═");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
