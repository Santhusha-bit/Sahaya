/**
 * Specialized financial-data reports, protected by x402 (the SELLER side).
 *
 * OPTIONAL EXPERIMENT. Benchmark reports Finance can buy to check a bill or
 * invoice against typical prices: care-facility costs by region, fair-price
 * ranges for common medical services, and cash prices for common generic drugs.
 * The figures are illustrative sample benchmarks for the demo, labeled as such
 * in every report; they are not authoritative pricing data.
 *
 *   GET ?report=<id>&region=<region>
 *     no X-PAYMENT  -> 402 + { x402Version, accepts: [PaymentRequirements] }
 *     X-PAYMENT ok  -> 200 + report JSON + X-PAYMENT-RESPONSE
 *     unknown report -> 404 (never charge for nothing)
 *
 * Sandbox only: the payee is the placeholder SANDBOX_PAY_TO (no key exists for
 * it) and the default facilitator is a local verifier that checks the signed
 * authorization but never settles on a chain.
 */

import {
  decodeHeader,
  encodeHeader,
  LocalVerifierFacilitator,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  SANDBOX_PAY_TO,
  TEST_NETWORK,
  usdToAtomic,
  X402_NETWORKS,
  X402_VERSION,
  type Facilitator,
  type PaymentPayload,
  type PaymentRequirements,
} from "@/integrations/x402";

export const REPORT_IDS = ["care-facility-costs", "medical-billing-benchmarks", "drug-price-benchmarks"] as const;
export type ReportId = (typeof REPORT_IDS)[number];

export const REGIONS = ["national", "west", "northeast", "midwest", "south"] as const;
export type Region = (typeof REGIONS)[number];

export const REPORT_PRICE_USD: Record<ReportId, number> = {
  "care-facility-costs": 0.25,
  "medical-billing-benchmarks": 0.15,
  "drug-price-benchmarks": 0.1,
};

export const REPORT_TITLES: Record<ReportId, string> = {
  "care-facility-costs": "Care facility cost benchmarks",
  "medical-billing-benchmarks": "Medical billing fair-price benchmarks",
  "drug-price-benchmarks": "Generic drug cash-price benchmarks",
};

export const DATA_NOTICE =
  "Illustrative sample benchmarks for the Sahaya demo, not authoritative pricing. Confirm with the provider, insurer, or Medicare before disputing a charge.";

const AS_OF = "2026-Q3 (illustrative)";

/** A price range: 25th percentile, median, 75th percentile. */
export interface Range {
  low: number;
  median: number;
  high: number;
}

export type CareType = "assisted-living" | "nursing-home" | "home-health-aide" | "adult-day";

const CARE_NATIONAL: Record<CareType, Range> = {
  "assisted-living": { low: 4500, median: 5900, high: 7300 },
  "nursing-home": { low: 8100, median: 9600, high: 11200 },
  "home-health-aide": { low: 5100, median: 6300, high: 7400 },
  "adult-day": { low: 1500, median: 2100, high: 2700 },
};

const REGION_FACTOR: Record<Region, number> = { national: 1, west: 1.15, northeast: 1.2, midwest: 0.9, south: 0.88 };

/** Typical monthly add-on fees, matched against invoice extras by keyword. */
const CARE_EXTRAS = [
  { service: "Laundry", keywords: ["laundry", "linen"], range: { low: 0, median: 40, high: 75 } },
  { service: "Medication management", keywords: ["medication", "med management", "meds"], range: { low: 150, median: 350, high: 600 } },
  { service: "Incontinence care", keywords: ["incontinence"], range: { low: 100, median: 250, high: 500 } },
  { service: "Transportation", keywords: ["transport", "rides", "shuttle"], range: { low: 0, median: 60, high: 120 } },
];

const MEDICAL_SERVICES = [
  { service: "Office visit (established patient)", keywords: ["office visit", "follow-up", "follow up", "doctor visit"], range: { low: 95, median: 140, high: 185 } },
  { service: "New patient visit", keywords: ["new patient"], range: { low: 150, median: 220, high: 300 } },
  { service: "Lab work / blood panel", keywords: ["lab", "blood", "panel"], range: { low: 25, median: 60, high: 110 } },
  { service: "X-ray", keywords: ["x-ray", "xray", "radiograph"], range: { low: 60, median: 140, high: 250 } },
  { service: "Physical therapy session", keywords: ["physical therapy", "pt session"], range: { low: 90, median: 130, high: 180 } },
  { service: "Emergency room visit", keywords: ["emergency", "er visit"], range: { low: 600, median: 1300, high: 2200 } },
  { service: "Medicare annual wellness visit", keywords: ["annual wellness", "wellness visit"], range: { low: 0, median: 0, high: 0 } },
];

const DRUGS = [
  { drug: "lisinopril", keywords: ["lisinopril"], range: { low: 4, median: 9, high: 15 } },
  { drug: "metformin", keywords: ["metformin"], range: { low: 4, median: 9, high: 15 } },
  { drug: "atorvastatin", keywords: ["atorvastatin", "lipitor"], range: { low: 6, median: 14, high: 25 } },
  { drug: "amlodipine", keywords: ["amlodipine", "norvasc"], range: { low: 4, median: 9, high: 15 } },
  { drug: "levothyroxine", keywords: ["levothyroxine", "synthroid"], range: { low: 8, median: 15, high: 25 } },
  { drug: "omeprazole", keywords: ["omeprazole", "prilosec"], range: { low: 8, median: 15, high: 25 } },
];

function scale(r: Range, f: number): Range {
  const round = (n: number) => Math.round((n * f) / 10) * 10;
  return { low: round(r.low), median: round(r.median), high: round(r.high) };
}

export interface FinancialReport {
  reportId: ReportId;
  title: string;
  region: Region;
  asOf: string;
  dataNotice: string;
  careCosts?: Record<CareType, Range>;
  careExtras?: typeof CARE_EXTRAS;
  medicalServices?: typeof MEDICAL_SERVICES;
  drugs?: (typeof DRUGS[number] & { supply: string })[];
  tips: string[];
}

export function buildReport(reportId: ReportId, region: Region): FinancialReport {
  const base = { reportId, title: REPORT_TITLES[reportId], region, asOf: AS_OF, dataNotice: DATA_NOTICE };
  if (reportId === "care-facility-costs") {
    const f = REGION_FACTOR[region];
    const careCosts = Object.fromEntries(
      (Object.keys(CARE_NATIONAL) as CareType[]).map((t) => [t, scale(CARE_NATIONAL[t], f)]),
    ) as Record<CareType, Range>;
    return {
      ...base,
      careCosts,
      careExtras: CARE_EXTRAS,
      tips: ["Ask for the fee schedule in writing; add-ons not in the contract can be disputed.", "Rate increases usually need 30 to 60 days' written notice."],
    };
  }
  if (reportId === "medical-billing-benchmarks") {
    return {
      ...base,
      medicalServices: MEDICAL_SERVICES,
      tips: ["Request an itemized bill with billing codes before paying.", "Medicare covers the annual wellness visit at no cost to the patient."],
    };
  }
  return {
    ...base,
    drugs: DRUGS.map((d) => ({ ...d, supply: "30-day generic, cash price" })),
    tips: ["Pharmacy discount cards and $4 generic lists are often cheaper than insurance copays for these drugs."],
  };
}

export function isReportId(v: string | null): v is ReportId {
  return !!v && (REPORT_IDS as readonly string[]).includes(v);
}

function asRegion(v: string | null): Region {
  return v && (REGIONS as readonly string[]).includes(v) ? (v as Region) : "national";
}

/** Canonical resource URL: origin + path + only the params that affect price/content. */
export function canonicalReportResource(origin: string, path: string, reportId: ReportId, region: Region): string {
  const u = new URL(path, origin);
  u.searchParams.set("report", reportId);
  u.searchParams.set("region", region);
  return u.toString();
}

export function reportRequirements(resource: string, reportId: ReportId): PaymentRequirements {
  const net = X402_NETWORKS[TEST_NETWORK];
  return {
    scheme: "exact",
    network: TEST_NETWORK,
    maxAmountRequired: usdToAtomic(REPORT_PRICE_USD[reportId]).toString(),
    resource,
    description: `${REPORT_TITLES[reportId]} (financial data report)`,
    mimeType: "application/json",
    payTo: SANDBOX_PAY_TO,
    maxTimeoutSeconds: 120,
    asset: net.usdc,
    extra: { name: net.usdcName, version: net.usdcVersion },
  };
}

const FACILITATOR_KEY = "__sahaya_x402_report_facilitator__";

/** The report service's own sandbox verifier: checks signatures, never settles. */
export function reportFacilitator(): Facilitator {
  const g = globalThis as Record<string, unknown>;
  if (!g[FACILITATOR_KEY]) g[FACILITATOR_KEY] = new LocalVerifierFacilitator();
  return g[FACILITATOR_KEY] as Facilitator;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export async function handleFinancialReport(req: Request, facilitator: Facilitator = reportFacilitator()): Promise<Response> {
  const url = new URL(req.url);
  const reportId = url.searchParams.get("report");
  if (!isReportId(reportId)) return json({ error: "no such report", available: REPORT_IDS }, 404);
  const region = asRegion(url.searchParams.get("region"));

  const requirement = reportRequirements(canonicalReportResource(url.origin, url.pathname, reportId, region), reportId);
  const paymentRequired = (error: string) => json({ x402Version: X402_VERSION, error, accepts: [requirement] }, 402);

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
    { report: buildReport(reportId, region), settlement: facilitator.backend === "local-verifier" ? "sandbox" : "testnet" },
    200,
    { [PAYMENT_RESPONSE_HEADER]: encodeHeader(settled) },
  );
}
