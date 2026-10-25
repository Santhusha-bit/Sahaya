import { handleFinancialReport } from "@/agents/finance/paidReports/financialReportService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * x402-protected financial-data report service (optional sandbox experiment).
 * Answers 402 Payment Required with x402 PaymentRequirements until a valid
 * X-PAYMENT header is supplied. Verified locally; never settles on a chain.
 */
export async function GET(req: Request) {
  return handleFinancialReport(req);
}
