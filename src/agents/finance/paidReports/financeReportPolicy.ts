/**
 * Finance's x402 payment policy. PURE and deterministic, layered on the shared
 * x402Policy hard rules (test network, USDC, registered service, pinned payee).
 *
 * Finance has NO payment authority of its own:
 *   - There is no standing mandate. Every report purchase needs the person's
 *     explicit approval of that exact quote (bound by requirement hash).
 *   - Only the sandbox wallet may pay. A funded key is refused outright.
 *   - Only "financial-data" services, never checkout or product data.
 *   - A per-report cap and a daily budget apply even after approval, so an
 *     approval can't be stretched into a bigger or repeated spend.
 */

import { atomicToUsd, usdToAtomic, type PaymentRequirements, type X402Wallet } from "@/integrations/x402";
import type { PaidDataService } from "@/agents/care/paidServices/registry";
import { evaluateX402Payment, type PolicyDecision } from "@/agents/care/paidServices/x402Policy";
import { FINANCE_PERMITTED_CATEGORIES } from "./registry";

/** Most Finance may pay for one report, approved or not. */
export const FINANCE_REPORT_CAP_USD = 0.5;
/** Most Finance may spend on reports per day, approved or not. */
export const FINANCE_DAILY_BUDGET_USD = 1.0;

export interface FinancePolicyInput {
  requirement: PaymentRequirements;
  service: PaidDataService | undefined;
  spentTodayAtomic: bigint;
  walletBackend: X402Wallet["backend"];
  /** Requirement hash the person approved, present only on the approved retry. */
  approvedHash?: string;
  now: number;
}

export function evaluateFinanceReportPayment(input: FinancePolicyInput): PolicyDecision {
  const base = evaluateX402Payment({
    requirement: input.requirement,
    service: input.service,
    mandate: null, // Finance never holds a standing spending authorization.
    spentTodayAtomic: input.spentTodayAtomic,
    approvedHash: input.approvedHash,
    now: input.now,
    permittedCategories: FINANCE_PERMITTED_CATEGORIES,
  });
  const refuse = (...reasons: string[]): PolicyDecision => ({ ...base, action: "refuse", authorizedBy: undefined, reasons });

  if (input.walletBackend !== "ephemeral") return refuse("Finance may only pay from the sandbox wallet, never a funded key");
  if (base.action === "refuse") return base;

  const amount = BigInt(input.requirement.maxAmountRequired);
  if (amount > usdToAtomic(FINANCE_REPORT_CAP_USD)) {
    return refuse(`a report may cost at most $${FINANCE_REPORT_CAP_USD.toFixed(2)}`);
  }
  if (input.spentTodayAtomic + amount > usdToAtomic(FINANCE_DAILY_BUDGET_USD)) {
    const left = atomicToUsd(usdToAtomic(FINANCE_DAILY_BUDGET_USD) - input.spentTodayAtomic);
    return refuse(`the $${FINANCE_DAILY_BUDGET_USD.toFixed(2)} daily report budget has $${Math.max(0, left).toFixed(2)} left`);
  }
  // Defense in depth: the only way Finance pays is an explicit approval.
  if (base.action === "pay" && base.authorizedBy !== "approval") return refuse("Finance can only pay with the person's approval");
  if (base.action === "needs_approval") {
    return { ...base, reasons: ["Finance has no standing payment authority, so every report purchase needs your OK"] };
  }
  return base;
}
