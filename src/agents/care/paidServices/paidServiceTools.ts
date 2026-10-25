import { z } from "zod";
import type { AgentTool } from "../../base/types";
import { formatUsd, getX402Wallet } from "@/integrations/x402";
import { x402Status } from "@/lib/env";
import { activeMandate, executeApprovedQuote, grantMandate, ledger, purchaseComparison, spentTodayAtomic } from "./paidServiceWorkflow";
import { atomicToUsd } from "@/integrations/x402";
import { HARD_CAP_USD } from "./x402Policy";

/** Care tools for paid agent services over Coinbase x402 (product data only). */
export const paidServiceTools: AgentTool[] = [
  {
    name: "compareProducts",
    description:
      "Buy a product comparison (unit price, and for 'detailed' also sodium/sugar/protein and an older-adult-friendly pick) from the paid product-data service over x402. Small test payments within the person's standing limit are paid automatically; anything above it asks for approval. Product DATA only, never a grocery checkout.",
    inputSchema: z.object({
      query: z.string().min(1).max(80).describe("Product to compare, e.g. 'oats', 'soup', 'yogurt'"),
      tier: z.enum(["basic", "detailed"]).default("basic"),
    }),
    async execute(input, ctx) {
      return purchaseComparison(ctx, { query: input.query, tier: input.tier });
    },
  },
  {
    name: "approvePaidDataPurchase",
    description:
      "Complete a paid product-data purchase the person approved. Bound to one quote and its exact payment terms; single use.",
    inputSchema: z.object({ quoteId: z.string().min(1), requirementHash: z.string().regex(/^[0-9a-f]{64}$/) }),
    requiresApproval: true,
    approvalSummary: () => ({
      title: "Pay for product data",
      description: "Care wants to complete a small paid product-data purchase (test USDC). Approve to pay.",
    }),
    async execute(input, ctx) {
      return executeApprovedQuote(ctx, input);
    },
  },
  {
    name: "getPaidServiceSpending",
    description: "Show the standing limit for paid agent services, what has been spent today, and recent purchases.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const mandate = await activeMandate(ctx.memory);
      const spentUsd = atomicToUsd(await spentTodayAtomic(ctx.memory));
      const recent = (await ledger(ctx.memory)).slice(0, 5).map((r) => ({
        id: r.id,
        service: r.data.serviceName,
        query: r.data.query,
        tier: r.data.tier,
        amountUsd: r.data.amountUsd,
        settlement: r.data.settlement,
        transaction: r.data.transaction,
        authorizedBy: r.data.authorizedBy,
        at: r.data.at,
      }));
      const limit = mandate
        ? `Standing limit: ${formatUsd(mandate.perPaymentLimitUsd)} per lookup, ${formatUsd(mandate.dailyLimitUsd)} per day.`
        : "No standing limit, so every paid lookup asks you first.";
      return {
        ok: true,
        summary: `${limit} Spent today: ${formatUsd(spentUsd)} across ${recent.length} recent purchase(s).`,
        data: { mandate, spentTodayUsd: spentUsd, recent, wallet: { address: getX402Wallet().address, backend: getX402Wallet().backend }, mode: x402Status().mode },
      };
    },
  },
  {
    name: "setPaidServiceLimit",
    description: "Change the standing limit for paid product-data lookups. Always requires the person's approval.",
    inputSchema: z.object({
      perPaymentLimitUsd: z.number().min(0).max(HARD_CAP_USD),
      dailyLimitUsd: z.number().min(0).max(5),
    }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: "Change paid-service limit",
      description: `Allow Care to pay up to ${formatUsd(input.perPaymentLimitUsd)} per product-data lookup and ${formatUsd(input.dailyLimitUsd)} per day without asking.`,
    }),
    async execute(input, ctx) {
      const mandate = await grantMandate(ctx.memory, input);
      await ctx.audit.record({ actor: "care", action: "x402.mandate_granted", correlationId: ctx.correlationId, detail: { ...input, mandateId: mandate.id } });
      return {
        ok: true,
        summary: `Updated: up to ${formatUsd(input.perPaymentLimitUsd)} per lookup, ${formatUsd(input.dailyLimitUsd)} per day.`,
        data: { mandate },
      };
    },
  },
];
