/**
 * Product-comparison data service, protected by x402 (the SELLER side).
 *
 * A specialized paid data product: side-by-side comparison of a few product
 * options (unit price, nutrition, older-adult-friendly notes) so Care can pick
 * the best-value / lowest-sodium option before building a grocery list. It sells
 * DATA only; it never sells or checks out groceries.
 *
 *   GET ?q=<product>&tier=basic|detailed
 *     no X-PAYMENT  -> 402 + { x402Version, accepts: [PaymentRequirements] }
 *     X-PAYMENT ok  -> 200 + comparison JSON + X-PAYMENT-RESPONSE
 *     unknown q     -> 404 (never charge for nothing)
 *
 * Pricing: basic $0.01, detailed $0.10 (Base Sepolia test USDC).
 */

import {
  decodeHeader,
  encodeHeader,
  getFacilitator,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  servicePayTo,
  TEST_NETWORK,
  usdToAtomic,
  X402_NETWORKS,
  X402_VERSION,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequirements,
} from "@/integrations/x402";

export type ComparisonTier = "basic" | "detailed";

export const TIER_PRICE_USD: Record<ComparisonTier, number> = { basic: 0.01, detailed: 0.1 };

interface ProductOption {
  name: string;
  brand: string;
  source: string;
  price: number;
  sizeOz: number;
  sodiumMg: number;
  sugarG: number;
  fiberG: number;
  proteinG: number;
  notes: string[];
}

interface ProductCategory {
  key: string;
  label: string;
  keywords: string[];
  options: ProductOption[];
}

const CATALOG: ProductCategory[] = [
  {
    key: "oats",
    label: "Rolled oats",
    keywords: ["oat", "oats", "oatmeal", "porridge"],
    options: [
      { name: "Old Fashioned Rolled Oats", brand: "Quaker", source: "Grocer A", price: 4.49, sizeOz: 18, sodiumMg: 0, sugarG: 1, fiberG: 4, proteinG: 5, notes: ["easy-pour canister"] },
      { name: "Organic Rolled Oats", brand: "Store brand", source: "Grocer B", price: 3.49, sizeOz: 18, sodiumMg: 0, sugarG: 1, fiberG: 4, proteinG: 5, notes: ["resealable bag"] },
      { name: "Instant Oatmeal, Maple", brand: "Quaker", source: "Grocer A", price: 4.29, sizeOz: 15.1, sodiumMg: 260, sugarG: 12, fiberG: 3, proteinG: 4, notes: ["single-serve packets", "high added sugar"] },
    ],
  },
  {
    key: "soup",
    label: "Vegetable soup",
    keywords: ["soup", "broth", "canned soup", "vegetable soup"],
    options: [
      { name: "Low-Sodium Vegetable Soup", brand: "Store brand", source: "Grocer B", price: 2.19, sizeOz: 18.6, sodiumMg: 140, sugarG: 5, fiberG: 3, proteinG: 3, notes: ["pull-tab lid"] },
      { name: "Hearty Vegetable Soup", brand: "Progresso", source: "Grocer A", price: 2.99, sizeOz: 19, sodiumMg: 690, sugarG: 6, fiberG: 3, proteinG: 4, notes: ["needs can opener"] },
      { name: "Organic Vegetable Soup", brand: "Amy's", source: "Grocer C", price: 3.79, sizeOz: 14.3, sodiumMg: 580, sugarG: 6, fiberG: 4, proteinG: 4, notes: ["pull-tab lid"] },
    ],
  },
  {
    key: "yogurt",
    label: "Greek yogurt",
    keywords: ["yogurt", "yoghurt", "greek yogurt"],
    options: [
      { name: "Plain Greek Yogurt, 4-pack", brand: "Fage", source: "Grocer A", price: 5.49, sizeOz: 21.2, sodiumMg: 65, sugarG: 5, fiberG: 0, proteinG: 16, notes: ["soft food"] },
      { name: "Greek Yogurt, 4-pack", brand: "Store brand", source: "Grocer B", price: 4.49, sizeOz: 21.2, sodiumMg: 60, sugarG: 6, fiberG: 0, proteinG: 15, notes: ["soft food"] },
      { name: "Strawberry Greek Yogurt, 4-pack", brand: "Chobani", source: "Grocer C", price: 5.29, sizeOz: 21.2, sodiumMg: 55, sugarG: 14, fiberG: 0, proteinG: 12, notes: ["soft food", "added sugar"] },
    ],
  },
  {
    key: "milk",
    label: "Milk",
    keywords: ["milk", "dairy"],
    options: [
      { name: "2% Milk, 1 gal", brand: "Store brand", source: "Grocer B", price: 3.79, sizeOz: 128, sodiumMg: 115, sugarG: 12, fiberG: 0, proteinG: 8, notes: ["heavy to carry"] },
      { name: "2% Milk, half gal", brand: "Horizon", source: "Grocer A", price: 4.49, sizeOz: 64, sodiumMg: 120, sugarG: 12, fiberG: 0, proteinG: 8, notes: ["lighter to carry", "lasts longer"] },
      { name: "Lactose-Free 2% Milk, half gal", brand: "Lactaid", source: "Grocer C", price: 4.99, sizeOz: 64, sodiumMg: 125, sugarG: 12, fiberG: 0, proteinG: 8, notes: ["lighter to carry", "lactose-free"] },
    ],
  },
  {
    key: "bread",
    label: "Whole-wheat bread",
    keywords: ["bread", "loaf", "wheat bread", "toast"],
    options: [
      { name: "Whole Wheat Bread", brand: "Store brand", source: "Grocer B", price: 2.99, sizeOz: 20, sodiumMg: 170, sugarG: 3, fiberG: 3, proteinG: 4, notes: [] },
      { name: "100% Whole Wheat", brand: "Dave's Killer Bread", source: "Grocer A", price: 5.99, sizeOz: 25, sodiumMg: 170, sugarG: 5, fiberG: 5, proteinG: 6, notes: ["seeded crust (harder to chew)"] },
      { name: "Soft Whole Wheat", brand: "Nature's Own", source: "Grocer C", price: 3.69, sizeOz: 20, sodiumMg: 140, sugarG: 3, fiberG: 2, proteinG: 4, notes: ["soft texture"] },
    ],
  },
];

export function findCategory(query: string): ProductCategory | undefined {
  const q = query.toLowerCase();
  return CATALOG.find((c) => c.keywords.some((k) => q.includes(k)) || q.includes(c.key));
}

const unitPrice = (o: ProductOption) => Number((o.price / o.sizeOz).toFixed(3));

function buildComparison(cat: ProductCategory, tier: ComparisonTier) {
  const rows = cat.options.map((o) => ({
    name: o.name,
    brand: o.brand,
    source: o.source,
    price: o.price,
    sizeOz: o.sizeOz,
    unitPricePerOz: unitPrice(o),
    ...(tier === "detailed"
      ? { sodiumMg: o.sodiumMg, sugarG: o.sugarG, fiberG: o.fiberG, proteinG: o.proteinG, notes: o.notes }
      : {}),
  }));
  const bestValue = [...cat.options].sort((a, b) => unitPrice(a) - unitPrice(b))[0];
  const result: Record<string, unknown> = {
    category: cat.label,
    tier,
    options: rows,
    bestValue: { name: bestValue.name, unitPricePerOz: unitPrice(bestValue) },
  };
  if (tier === "detailed") {
    const lowestSodium = [...cat.options].sort((a, b) => a.sodiumMg - b.sodiumMg)[0];
    // Older-adult-friendly pick: low sodium and added sugar first, then value.
    const score = (o: ProductOption) => o.sodiumMg / 100 + o.sugarG / 4 - o.proteinG / 8 - o.fiberG / 4 + unitPrice(o) * 10;
    const recommended = [...cat.options].sort((a, b) => score(a) - score(b))[0];
    result.lowestSodium = { name: lowestSodium.name, sodiumMg: lowestSodium.sodiumMg };
    result.recommended = {
      name: recommended.name,
      why: `Lower sodium/sugar for the price${recommended.notes.length ? `; ${recommended.notes.join(", ")}` : ""}.`,
    };
  }
  return result;
}

export function requirementsFor(resource: string, tier: ComparisonTier): PaymentRequirements {
  const net = X402_NETWORKS[TEST_NETWORK];
  return {
    scheme: "exact",
    network: TEST_NETWORK,
    maxAmountRequired: usdToAtomic(TIER_PRICE_USD[tier]).toString(),
    resource,
    description: `Product comparison (${tier})`,
    mimeType: "application/json",
    payTo: servicePayTo(),
    maxTimeoutSeconds: 120,
    asset: net.usdc,
    extra: { name: net.usdcName, version: net.usdcVersion },
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Canonical resource URL: origin + path + only the params that affect price/content. */
export function canonicalResource(origin: string, path: string, q: string, tier: ComparisonTier): string {
  const u = new URL(path, origin);
  u.searchParams.set("q", q);
  u.searchParams.set("tier", tier);
  return u.toString();
}

export async function handleProductCompare(req: Request, facilitator: Facilitator = getFacilitator()): Promise<Response> {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const tier: ComparisonTier = url.searchParams.get("tier") === "detailed" ? "detailed" : "basic";
  const cat = q ? findCategory(q) : undefined;
  if (!cat) return json({ error: "no comparison data for that product", available: CATALOG.map((c) => c.key) }, 404);

  const requirement = requirementsFor(canonicalResource(url.origin, url.pathname, cat.key, tier), tier);
  const paymentRequired = (error: string) =>
    json({ x402Version: X402_VERSION, error, accepts: [requirement] }, 402);

  const header = req.headers.get(PAYMENT_HEADER);
  if (!header) return paymentRequired(`${PAYMENT_HEADER} header is required`);

  let payment: PaymentPayload;
  try {
    payment = decodeHeader<PaymentPayload>(header);
  } catch {
    return paymentRequired("malformed payment header");
  }

  const verified = await facilitator.verify(payment, requirement).catch((err: unknown) => ({
    isValid: false,
    invalidReason: err instanceof Error ? err.message : String(err),
  }));
  if (!verified.isValid) return paymentRequired(`payment rejected: ${verified.invalidReason ?? "invalid"}`);

  const settled = await facilitator.settle(payment, requirement).catch((err: unknown) => ({
    success: false,
    transaction: "",
    network: requirement.network,
    errorReason: err instanceof Error ? err.message : String(err),
  }));
  if (!settled.success) return paymentRequired(`settlement failed: ${settled.errorReason ?? "unknown"}`);

  return json(
    { comparison: buildComparison(cat, tier), settlement: facilitator.backend === "local-verifier" ? "sandbox" : "testnet" },
    200,
    { [PAYMENT_RESPONSE_HEADER]: encodeHeader(settled) },
  );
}
