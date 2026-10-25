import { handleProductCompare } from "@/agents/care/paidServices/productCompareService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * x402-protected product-comparison data service. Answers 402 Payment Required
 * with x402 PaymentRequirements until a valid X-PAYMENT header is supplied.
 */
export async function GET(req: Request) {
  return handleProductCompare(req);
}
