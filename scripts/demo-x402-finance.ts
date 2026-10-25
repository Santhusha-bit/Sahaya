/**
 * npm run demo:x402-finance
 *
 * OPTIONAL EXPERIMENT: Finance buys a specialized financial-data report over
 * Coinbase x402, with no payment authority of its own.
 *   1. Finance asks for a care-facility cost benchmark and gets the quoted price
 *      (402). It does NOT pay: it opens an approval card for that exact price.
 *   2. The person approves; Finance pays in sandbox (throwaway key, local
 *      verifier, nothing settles) and applies the report to the invoice.
 *   3. Guardrails: replaying the approval, a raised price, a funded wallet,
 *      a mainnet quote, and an over-budget purchase are all refused in code.
 */

import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { X402_NETWORKS } from "@/integrations/x402";
import { requirementHash } from "@/agents/care/paidServices/x402Policy";
import { IN_PROCESS_ORIGIN } from "@/agents/care/paidServices/registry";
import { canonicalReportResource, reportRequirements } from "@/agents/finance/paidReports/financialReportService";
import { evaluateFinanceReportPayment } from "@/agents/finance/paidReports/financeReportPolicy";
import { FINANCIAL_REPORT_PATH, findFinanceReportService } from "@/agents/finance/paidReports/registry";
import { REPORT_LEDGER } from "@/agents/finance/paidReports/financeReportWorkflow";

function line(c = "-") {
  console.log(c.repeat(72));
}

async function main() {
  process.env.FINANCE_X402_REPORTS = "on";
  const USER = "demo-margaret";
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const finance = createAgent("finance", { data, userId: USER });

  line("=");
  console.log("SAHAYA: Finance buys a financial-data report over x402 (sandbox experiment)");
  line("=");
  console.log((await finance.executeTool("getFinancialReportSpending", {})).result.summary);

  // 1. Quote + approval card.
  line();
  console.log('1) "Is my assisted living rate fair? Get a benchmark report"');
  const one = await service.sendMessage("finance", "Is my assisted living rate fair? Get a benchmark report");
  console.log(one.reply.text);
  const approvalId = one.reply.approvalsRequested[0];
  const pending = await data.approvals.get(approvalId);
  console.log(`\n   APPROVAL CARD: ${pending?.title}\n   ${pending?.description}`);
  console.log(`   Ledger before approval: ${(await finance.memory.list(REPORT_LEDGER)).length} purchase(s)`);

  // 2. Approve -> sandbox payment -> report applied.
  line();
  console.log("2) The person taps Approve");
  const decided = await service.decideApproval("finance", approvalId, "approve");
  console.log(`   ${decided.record?.summary}`);
  const audited = await finance.executeTool("auditCareFacilityInvoice", {
    facility: "Sunrise Senior Living",
    agreedMonthly: 4500,
    invoiceTotal: 4620,
    extras: [{ description: "Laundry", amount: 120 }],
  });
  console.log(`\n   Invoice audit now uses the report:\n   ${audited.result.summary}`);

  // 3. Guardrails.
  line();
  console.log("3) Guardrails (all refused in code)");
  const replay = await finance.executeTool("purchaseApprovedFinancialReport", pending!.input, { approved: true });
  console.log(`   replayed approval        -> ${replay.result.summary}`);
  const resource = canonicalReportResource(IN_PROCESS_ORIGIN, FINANCIAL_REPORT_PATH, "care-facility-costs", "national");
  const base = reportRequirements(resource, "care-facility-costs");
  const check = (label: string, r: typeof base, opts: { approvedHash?: string; spent?: bigint; backend?: "ephemeral" | "testnet-wallet" } = {}) => {
    const d = evaluateFinanceReportPayment({
      requirement: r,
      service: findFinanceReportService(r.resource),
      spentTodayAtomic: opts.spent ?? 0n,
      walletBackend: opts.backend ?? "ephemeral",
      approvedHash: opts.approvedHash,
      now: Date.now(),
    });
    console.log(`   ${label.padEnd(24)} -> ${d.action}: ${d.reasons.join("; ")}`);
  };
  check("no approval ($0.25)", base);
  check("price raised after OK", { ...base, maxAmountRequired: "400000" }, { approvedHash: requirementHash(base) });
  check("funded wallet (approved)", base, { approvedHash: requirementHash(base), backend: "testnet-wallet" });
  const mainnet = { ...base, network: "base", asset: X402_NETWORKS.base.usdc };
  check("mainnet (approved)", mainnet, { approvedHash: requirementHash(mainnet) });
  check("over daily budget", base, { approvedHash: requirementHash(base), spent: 900000n });

  line();
  console.log("Finance report ledger:");
  for (const r of await finance.memory.list(REPORT_LEDGER)) {
    console.log(`   $${Number(r.data.amountUsd).toFixed(2)}  ${r.data.report} (${r.data.region})  ${r.data.authorizedBy}, ${r.data.settlement}, ${r.data.transaction}`);
  }
  console.log("Audit trail:");
  for (const a of await finance.audit.list()) {
    if (a.action.startsWith("x402")) console.log(`   ${a.action.padEnd(20)} ${JSON.stringify(a.detail?.reasons ?? a.detail?.transaction ?? "")}`);
  }
  line("=");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
