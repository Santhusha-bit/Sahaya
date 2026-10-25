/**
 * Registry of paid agent services Care is permitted to buy from over x402.
 *
 * Deliberately tiny and narrowly scoped: a single product-data service. x402 is
 * for machine-to-machine data purchases; it is NOT a grocery checkout. Groceries
 * still go through requestOrderApproval -> Finance review. The policy refuses any
 * requirement whose resource is not registered here, and any service whose
 * category is not in PERMITTED_CATEGORIES.
 */

import type { Hex } from "viem";
import { servicePayTo, TEST_NETWORK } from "@/integrations/x402";

export type PaidServiceCategory = "product-data" | "financial-data" | "checkout";

/** Categories Care may pay for via x402. Checkout is never one of them. */
export const PERMITTED_CATEGORIES: readonly PaidServiceCategory[] = ["product-data"];

export interface PaidDataService {
  id: string;
  name: string;
  category: PaidServiceCategory;
  /** Path of the x402-protected resource. */
  resourcePath: string;
  /** Origins the resource may be served from. */
  allowedOrigins: string[];
  payTo: Hex;
  network: string;
  /** Per-call price ceiling for this service, regardless of approval. */
  maxPriceUsd: number;
}

/** Origin used when Care calls the built-in service in-process. */
export const IN_PROCESS_ORIGIN = "http://kinline.local";

export const PRODUCT_COMPARE_PATH = "/api/x402/product-compare";

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

export function productCompareService(): PaidDataService {
  const origins = [IN_PROCESS_ORIGIN, originOf(process.env.X402_SERVICE_URL), originOf(process.env.APP_BASE_URL)].filter(
    (o): o is string => !!o,
  );
  return {
    id: "product-compare",
    name: "Kinline Product Data (x402 test service)",
    category: "product-data",
    resourcePath: PRODUCT_COMPARE_PATH,
    allowedOrigins: [...new Set(origins)],
    payTo: servicePayTo(),
    network: TEST_NETWORK,
    maxPriceUsd: 0.25,
  };
}

export function paidServiceRegistry(): PaidDataService[] {
  return [productCompareService()];
}

/** Find the registered service a resource URL belongs to (origin + path match). */
export function findServiceForResource(resource: string, registry = paidServiceRegistry()): PaidDataService | undefined {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  return registry.find((s) => s.resourcePath === url.pathname && s.allowedOrigins.includes(url.origin));
}
