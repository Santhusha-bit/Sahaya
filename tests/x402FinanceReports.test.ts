import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { createWallet, X402_NETWORKS, type PaymentRequirements } from "@/integrations/x402";
import { IN_PROCESS_ORIGIN, productCompareService } from "@/agents/care/paidServices/registry";
import { evaluateX402Payment, requirementHash } from "@/agents/care/paidServices/x402Policy";
import { buildReport, canonicalReportResource, handleFinancialReport, reportRequirements } from "@/agents/finance/paidReports/financialReportService";
import { evaluateFinanceReportPayment } from "@/agents/finance/paidReports/financeReportPolicy";
import { FINANCIAL_REPORT_PATH, financialReportService, findFinanceReportService } from "@/agents/finance/paidReports/registry";
import { incorporateReport } from "@/agents/finance/paidReports/reportInsights";
import {
  REPORT_LEDGER,
  REPORT_QUOTES,
  REPORTS,
  setFinanceWallet,
  setReportTransport,
} from "@/agents/finance/paidReports/financeReportWorkflow";

const USER = "user-x402-finance";
const RESOURCE = canonicalReportResource(IN_PROCESS_ORIGIN, FINANCIAL_REPORT_PATH, "care-facility-costs", "national");

function req(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { ...reportRequirements(RESOURCE, "care-facility-costs"), ...over };
}

function decide(r: PaymentRequirements, opts: { spent?: bigint; approvedHash?: string; backend?: "ephemeral" | "testnet-wallet" } = {}) {
  return evaluateFinanceReportPayment({
    requirement: r,
    service: findFinanceReportService(r.resource),
    spentTodayAtomic: opts.spent ?? 0n,
    walletBackend: opts.backend ?? "ephemeral",
    approvedHash: opts.approvedHash,
    now: Date.now(),
  });
}

async function setup() {
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  await service.initializeAll();
  const finance = createAgent("finance", { data, userId: USER });
  return { data, service, finance };
}

const CARE_REQUEST = {
  report: "care-facility-costs",
  region: "national",
  context: { monthlyCost: 4500, extras: [{ description: "Laundry", amount: 120 }] },
};

beforeEach(() => {
  process.env.FINANCE_X402_REPORTS = "on";
  setFinanceWallet(null);
  setReportTransport(null);
});
afterEach(() => {
  delete process.env.FINANCE_X402_REPORTS;
  setReportTransport(null);
});

describe("Finance x402 policy: no standing payment authority", () => {
  it("never pays without approval, even for the cheapest report", () => {
    const d = decide(req({ maxAmountRequired: "1" }));
    expect(d.action).toBe("needs_approval");
    expect(d.reasons[0]).toMatch(/no standing payment authority/);
  });

  it("pays only with an approval for exactly these terms", () => {
    const r = req();
    expect(decide(r, { approvedHash: requirementHash(r) })).toMatchObject({ action: "pay", authorizedBy: "approval" });
    const raised = req({ maxAmountRequired: "300000" });
    expect(decide(raised, { approvedHash: requirementHash(r) }).action).toBe("refuse");
  });

  it("caps each report and the daily budget even when approved", () => {
    const big = req({ maxAmountRequired: "600000" }); // $0.60
    expect(decide(big, { approvedHash: requirementHash(big) }).action).toBe("refuse");
    const r = req();
    const d = decide(r, { approvedHash: requirementHash(r), spent: 900000n }); // $0.90 already spent
    expect(d.action).toBe("refuse");
    expect(d.reasons[0]).toMatch(/daily report budget/);
  });

  it("refuses a funded wallet: Finance pays from the sandbox key only", () => {
    const r = req();
    const d = decide(r, { approvedHash: requirementHash(r), backend: "testnet-wallet" });
    expect(d.action).toBe("refuse");
  });

  it("refuses mainnet, wrong payees, and unregistered origins even when approved", () => {
    const mainnet = req({ network: "base", asset: X402_NETWORKS.base.usdc });
    expect(decide(mainnet, { approvedHash: requirementHash(mainnet) }).action).toBe("refuse");
    const payee = req({ payTo: "0x000000000000000000000000000000000000bEEF" });
    expect(decide(payee, { approvedHash: requirementHash(payee) }).action).toBe("refuse");
    const external = req({ resource: RESOURCE.replace(IN_PROCESS_ORIGIN, "https://evil.example") });
    expect(decide(external, { approvedHash: requirementHash(external) }).action).toBe("refuse");
  });

  it("agents stay in their lane: Care can't buy financial data, Finance can't buy product data", () => {
    const r = req();
    const careDecision = evaluateX402Payment({ requirement: r, service: financialReportService(), mandate: null, spentTodayAtomic: 0n, approvedHash: requirementHash(r), now: Date.now() });
    expect(careDecision.action).toBe("refuse");
    const financeDecision = evaluateFinanceReportPayment({ requirement: r, service: productCompareService(), spentTodayAtomic: 0n, walletBackend: "ephemeral", approvedHash: requirementHash(r), now: Date.now() });
    expect(financeDecision.action).toBe("refuse");
  });
});

describe("financial-report seller", () => {
  it("quotes with 402, pinned to the sandbox payee", async () => {
    const res = await handleFinancialReport(new Request(`${IN_PROCESS_ORIGIN}${FINANCIAL_REPORT_PATH}?report=drug-price-benchmarks`));
    expect(res.status).toBe(402);
    const body = (await res.json()) as { accepts: PaymentRequirements[] };
    expect(body.accepts[0]).toMatchObject({ maxAmountRequired: "100000", network: "base-sepolia", payTo: financialReportService().payTo });
  });

  it("does not charge for unknown reports", async () => {
    const res = await handleFinancialReport(new Request(`${IN_PROCESS_ORIGIN}${FINANCIAL_REPORT_PATH}?report=stock-tips`));
    expect(res.status).toBe(404);
  });
});

describe("report insights", () => {
  it("applies a care-cost benchmark to an invoice", () => {
    const i = incorporateReport(buildReport("care-facility-costs", "national"), CARE_REQUEST.context);
    expect(i.findings[0]).toMatch(/lower half of the typical range/);
    expect(i.flags[0]).toMatch(/Laundry .* above the typical/);
    expect(i.possibleSavingsUsd).toBe(45);
  });

  it("flags overpriced and duplicate medical charges", () => {
    const i = incorporateReport(buildReport("medical-billing-benchmarks", "national"), {
      lineItems: [{ description: "Office visit", amount: 240 }, { description: "Lab work", amount: 60 }, { description: "Office visit", amount: 240 }],
    });
    expect(i.flags.some((f) => /Office visit .* above/.test(f))).toBe(true);
    expect(i.flags.some((f) => /billed 2 times/.test(f))).toBe(true);
  });
});

describe("Finance x402 report workflow end to end", () => {
  it("is off unless the experiment flag is enabled", async () => {
    delete process.env.FINANCE_X402_REPORTS;
    const { finance } = await setup();
    const r = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    expect(r.result).toMatchObject({ ok: false, error: "experiment_disabled" });
  });

  it("quotes, asks for approval, pays in sandbox once approved, and incorporates the report", async () => {
    const { data, service, finance } = await setup();

    const asked = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    expect(asked.result.ok).toBe(true);
    expect(asked.result.approvalId).toBeTruthy();
    expect(asked.result.summary).toMatch(/\$0\.25/);
    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(0);
    const approval = await data.approvals.get(asked.result.approvalId!);
    expect(approval?.description).toMatch(/no spending authority of its own/);

    const decided = await service.decideApproval("finance", asked.result.approvalId!, "approve");
    expect(decided.record?.status).toBe("success");
    const out = decided.record?.output as any;
    expect(out.purchase).toMatchObject({ amountUsd: 0.25, authorizedBy: "approval", settlement: "sandbox" });
    expect(out.purchase.transaction).toMatch(/^sandbox:/);
    expect(out.insights.flags[0]).toMatch(/Laundry/);

    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(1);
    expect(await finance.memory.list(REPORTS)).toHaveLength(1);
    const audit = (await finance.audit.list()).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["x402.needs_approval", "x402.pay", "x402.paid"]));

    // The purchased benchmark now feeds the existing invoice audit.
    const audited = await finance.executeTool("auditCareFacilityInvoice", { facility: "Sunrise", agreedMonthly: 4500, invoiceTotal: 4620, extras: [{ description: "Laundry", amount: 120 }] });
    expect(audited.result.summary).toMatch(/Against the purchased benchmark/);

    // Asking again the same day reuses the report: no second quote, no second payment.
    const again = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    expect((again.result.data as any).status).toBe("reused");
    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(1);

    // Replaying the approved call is refused.
    const replay = await finance.executeTool("purchaseApprovedFinancialReport", approval!.input, { approved: true });
    expect(replay.result).toMatchObject({ ok: false, error: "quote_already_used" });
  });

  it("the model can't skip the approval by calling the purchase tool directly", async () => {
    const { finance } = await setup();
    const asked = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    const { quoteId, requirementHash: hash } = asked.result.data as any;
    const direct = await finance.executeTool("purchaseApprovedFinancialReport", { quoteId, requirementHash: hash });
    expect(direct.record.status).toBe("awaiting_approval");
    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(0);
  });

  it("rejecting the approval spends nothing", async () => {
    const { service, finance } = await setup();
    const asked = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    await service.decideApproval("finance", asked.result.approvalId!, "reject");
    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(0);
  });

  it("refuses to pay if the service raises the price after approval", async () => {
    const { service, finance } = await setup();
    const asked = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
    setReportTransport(async (url, headers) => {
      const res = await handleFinancialReport(new Request(url, { headers }));
      if (res.status !== 402) return res;
      const body = (await res.json()) as { accepts: PaymentRequirements[] };
      body.accepts[0].maxAmountRequired = "400000";
      return new Response(JSON.stringify(body), { status: 402 });
    });
    const decided = await service.decideApproval("finance", asked.result.approvalId!, "approve");
    expect(decided.record?.status).toBe("error");
    expect(decided.record?.summary).toMatch(/changed since they were approved/);
    expect(await finance.memory.list(REPORT_LEDGER)).toHaveLength(0);
    const quotes = await finance.memory.list(REPORT_QUOTES);
    expect(quotes[0].data.status).toBe("failed");
  });

  it("ignores a funded X402_WALLET_PRIVATE_KEY: Finance always signs with a throwaway key", async () => {
    process.env.X402_WALLET_PRIVATE_KEY = generatePrivateKey();
    try {
      const { finance } = await setup();
      const spending = await finance.executeTool("getFinancialReportSpending", {});
      expect((spending.result.data as any).wallet.backend).toBe("ephemeral");
      expect((spending.result.data as any).limits.standingAuthority).toBe(false);
      // Even if a funded wallet were injected, the policy refuses to pay with it.
      setFinanceWallet(createWallet(generatePrivateKey(), "testnet-wallet"));
      const asked = await finance.executeTool("requestFinancialReport", CARE_REQUEST);
      expect(asked.result).toMatchObject({ ok: false, error: "x402_refused" });
    } finally {
      delete process.env.X402_WALLET_PRIVATE_KEY;
    }
  });
});
