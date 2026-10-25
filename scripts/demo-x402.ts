/**
 * npm run demo:x402
 *
 * Coinbase x402 paid agent services: Care buys a product comparison from a paid
 * data service.
 *   1. A $0.01 basic comparison is within the previously authorized limit, so it
 *      is paid automatically and unlocks the data.
 *   2. A $0.10 detailed comparison is over the limit, so Care asks first; once the
 *      person approves, exactly that payment goes through.
 *   3. Guardrails: replaying the approval, a mainnet requirement, a wrong payee
 *      and a "checkout" service are all refused in code.
 * Sandbox (throwaway key + local verifier, nothing settles) unless
 * X402_WALLET_PRIVATE_KEY + X402_PAY_TO configure a funded Base Sepolia wallet.
 */

import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { getX402Wallet, X402_NETWORKS } from "@/integrations/x402";
import { x402Status } from "@/lib/env";
import { LEDGER } from "@/agents/care/paidServices/paidServiceWorkflow";
import { requirementsFor } from "@/agents/care/paidServices/productCompareService";
import { findServiceForResource, IN_PROCESS_ORIGIN, PRODUCT_COMPARE_PATH, productCompareService } from "@/agents/care/paidServices/registry";
import { evaluateX402Payment, requirementHash } from "@/agents/care/paidServices/x402Policy";

function line(c = "-") {
  console.log(c.repeat(72));
}

async function main() {
  const USER = "demo-margaret";
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const care = createAgent("care", { data, userId: USER });
  const wallet = getX402Wallet();

  line("=");
  console.log("SAHAYA: Coinbase x402 paid agent services demo");
  console.log(`x402: ${x402Status().mode}. ${x402Status().detail}`);
  console.log(`Care wallet: ${wallet.address} (${wallet.backend})`);
  line("=");

  const spending = await care.executeTool("getPaidServiceSpending", {});
  console.log(`\n${spending.result.summary}`);

  // 1. Within the standing limit.
  line();
  console.log('1) "Compare oats for the best value"');
  const one = await service.sendMessage("care", "Compare oats for the best value");
  console.log(one.reply.text);
  const p1 = (one.reply.toolCalls[0]?.output as any)?.purchase;
  if (p1) console.log(`   receipt: ${p1.transaction} | payer ${p1.payer} | authorized by ${p1.authorizedBy}`);

  // 2. Over the limit: approval.
  line();
  console.log('2) "Which soup is healthiest? I need low sodium"');
  const two = await service.sendMessage("care", "Which soup is healthiest? I need low sodium");
  console.log(two.reply.text);
  const approvalId = two.reply.approvalsRequested[0];
  const pending = await data.approvals.get(approvalId);
  console.log(`\n   APPROVAL CARD: ${pending?.title}\n   ${pending?.description}`);
  console.log("   ...the person taps Approve...");
  const decided = await service.decideApproval("care", approvalId, "approve");
  console.log(`   ${decided.record?.summary}`);

  // 3. Guardrails.
  line();
  console.log("3) Guardrails (all refused in code)");
  const replay = await care.executeTool("approvePaidDataPurchase", pending!.input, { approved: true });
  console.log(`   replayed approval      -> ${replay.result.summary}`);
  const resource = `${IN_PROCESS_ORIGIN}${PRODUCT_COMPARE_PATH}?q=oats&tier=basic`;
  const base = requirementsFor(resource, "basic");
  const mandate = {
    id: "m",
    perPaymentLimitUsd: 0.05,
    dailyLimitUsd: 0.25,
    allowedServiceIds: ["product-compare"],
    network: "base-sepolia",
    grantedBy: "user",
    grantedAt: 0,
  };
  const check = (label: string, r: typeof base, svc = findServiceForResource(r.resource)) => {
    const d = evaluateX402Payment({ requirement: r, service: svc, mandate, spentTodayAtomic: 0n, approvedHash: requirementHash(r), now: Date.now() });
    console.log(`   ${label.padEnd(22)} -> ${d.action}: ${d.reasons.join("; ")}`);
  };
  check("mainnet (approved)", { ...base, network: "base", asset: X402_NETWORKS.base.usdc });
  check("wrong payee (approved)", { ...base, payTo: "0x000000000000000000000000000000000000bEEF" });
  check("grocery checkout", base, { ...productCompareService(), id: "grocer-checkout", category: "checkout" });

  // Ledger + Finance.
  line();
  console.log("Care cost ledger:");
  for (const r of await care.memory.list(LEDGER)) {
    console.log(`   $${Number(r.data.amountUsd).toFixed(2)}  ${r.data.tier} ${r.data.query}  (${r.data.authorizedBy}, ${r.data.settlement}, ${r.data.transaction})`);
  }
  console.log("Finance received:");
  for (const t of await data.tasks.list({ userId: USER, agentId: "finance" })) {
    if (t.title.startsWith("Paid data service")) console.log(`   ${t.title}`);
  }
  console.log("Audit trail:");
  for (const a of await care.audit.list()) {
    if (a.action.startsWith("x402")) console.log(`   ${a.action.padEnd(20)} ${JSON.stringify(a.detail?.reasons ?? a.detail?.transaction ?? "")}`);
  }
  line("=");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
