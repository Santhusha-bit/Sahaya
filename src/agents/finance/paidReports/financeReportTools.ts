import { z } from "zod";
import type { AgentTool } from "../../base/types";
import { atomicToUsd, formatUsd } from "@/integrations/x402";
import { REGIONS, REPORT_IDS, REPORT_PRICE_USD, REPORT_TITLES } from "./financialReportService";
import { FINANCE_DAILY_BUDGET_USD, FINANCE_REPORT_CAP_USD } from "./financeReportPolicy";
import { financeReportsEnabled, getFinanceWallet, purchaseApprovedReport, reportLedger, reportSpentTodayAtomic, requestFinancialReport } from "./financeReportWorkflow";

const lineItem = z.object({ description: z.string().min(1).max(120), amount: z.number().nonnegative() });

/**
 * Finance tools for buying specialized financial-data reports over x402
 * (optional experiment, sandbox only). Finance can request a quote; only the
 * person's approval of that exact quote lets it pay.
 */
export const financeReportTools: AgentTool[] = [
  {
    name: "requestFinancialReport",
    description:
      "Get a price quote for a specialized financial-data report (care-facility cost benchmarks by region, medical-billing fair prices, or generic drug cash prices) from the paid report service over x402, and ask the person to approve it. Never pays by itself. Pass context (the invoice amount and extras, bill line items, or a drug and price paid) so the report can be applied once bought. Sandbox experiment: no real money moves.",
    inputSchema: z.object({
      report: z.enum(REPORT_IDS),
      region: z.enum(REGIONS).default("national"),
      context: z
        .object({
          monthlyCost: z.number().nonnegative().optional(),
          careType: z.enum(["assisted-living", "nursing-home", "home-health-aide", "adult-day"]).optional(),
          extras: z.array(lineItem).max(20).optional(),
          lineItems: z.array(lineItem).max(50).optional(),
          drug: z.string().max(60).optional(),
          pricePaid: z.number().nonnegative().optional(),
        })
        .optional(),
    }),
    async execute(input, ctx) {
      return requestFinancialReport(ctx, input);
    },
  },
  {
    name: "purchaseApprovedFinancialReport",
    description:
      "Complete a financial-report purchase the person approved. Bound to one quote and its exact payment terms; single use; sandbox payment only.",
    inputSchema: z.object({ quoteId: z.string().min(1), requirementHash: z.string().regex(/^[0-9a-f]{64}$/) }),
    requiresApproval: true,
    approvalSummary: () => ({
      title: "Pay for a financial report",
      description: "Finance wants to complete a small sandbox payment for a financial-data report. Approve to pay.",
    }),
    async execute(input, ctx) {
      return purchaseApprovedReport(ctx, input);
    },
  },
  {
    name: "getFinancialReportSpending",
    description: "Show what Finance has spent on paid financial reports today, the limits that apply, and recent purchases.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const spentUsd = atomicToUsd(await reportSpentTodayAtomic(ctx.memory));
      const recent = (await reportLedger(ctx.memory)).slice(0, 5).map((r) => ({
        id: r.id,
        report: r.data.report,
        region: r.data.region,
        amountUsd: r.data.amountUsd,
        transaction: r.data.transaction,
        at: r.data.at,
      }));
      const status = financeReportsEnabled() ? "on (sandbox only)" : "off";
      return {
        ok: true,
        summary: `Paid financial reports are ${status}. Every purchase needs your approval; at most ${formatUsd(FINANCE_REPORT_CAP_USD)} per report and ${formatUsd(FINANCE_DAILY_BUDGET_USD)} per day. Spent today: ${formatUsd(spentUsd)}.`,
        data: {
          enabled: financeReportsEnabled(),
          spentTodayUsd: spentUsd,
          limits: { perReportUsd: FINANCE_REPORT_CAP_USD, dailyUsd: FINANCE_DAILY_BUDGET_USD, standingAuthority: false },
          catalog: REPORT_IDS.map((id) => ({ id, title: REPORT_TITLES[id], priceUsd: REPORT_PRICE_USD[id] })),
          recent,
          wallet: { address: getFinanceWallet().address, backend: getFinanceWallet().backend },
        },
      };
    },
  },
];
