/**
 * Paid data services Finance may buy from over x402. One entry: the in-process
 * financial-report service. Only the in-process origin is registered, so a
 * configured external URL can never redirect Finance's payments elsewhere, and
 * the payee is pinned to the sandbox placeholder address.
 */

import { SANDBOX_PAY_TO, TEST_NETWORK } from "@/integrations/x402";
import { IN_PROCESS_ORIGIN, type PaidDataService, type PaidServiceCategory } from "@/agents/care/paidServices/registry";

/** Categories Finance may pay for via x402: financial data only. */
export const FINANCE_PERMITTED_CATEGORIES: readonly PaidServiceCategory[] = ["financial-data"];

export const FINANCIAL_REPORT_PATH = "/api/x402/financial-report";

export function financialReportService(): PaidDataService {
  return {
    id: "financial-report",
    name: "Kinline Financial Data Reports (x402 sandbox service)",
    category: "financial-data",
    resourcePath: FINANCIAL_REPORT_PATH,
    allowedOrigins: [IN_PROCESS_ORIGIN],
    payTo: SANDBOX_PAY_TO,
    network: TEST_NETWORK,
    maxPriceUsd: 0.5,
  };
}

export function findFinanceReportService(resource: string): PaidDataService | undefined {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  const s = financialReportService();
  return s.resourcePath === url.pathname && s.allowedOrigins.includes(url.origin) ? s : undefined;
}
