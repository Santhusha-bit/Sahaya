/**
 * Validate, normalize and compare public product listings for Care.
 *
 * Provider output (Bright Data or sandbox) is untrusted web content. Nothing here
 * trusts it: each listing is schema-checked, its text sanitized, injected
 * instructions dropped, sizes parsed into a common unit, and outliers flagged before
 * anything is compared, shown to the person, or put in a cart.
 */

import { z } from "zod";
import type { ListingFetch, RawListing } from "@/integrations/brightdata";

export type Dimension = "volume" | "weight" | "count";

export interface ParsedSize {
  dimension: Dimension;
  /** Quantity in the base unit (fl oz, oz, or items). */
  quantity: number;
  label: string;
  /** A bare "oz" can mean fluid ounces on liquids; comparison may reinterpret it. */
  ambiguousOz?: boolean;
}

export type Availability = "in_stock" | "out_of_stock" | "unknown";

export interface NormalizedListing {
  id: string;
  title: string;
  merchant: string;
  price: number;
  currency: "USD";
  size: ParsedSize | null;
  unitPrice: number | null;
  unitLabel: string | null;
  availability: Availability;
  link: string;
  rating: number | null;
  source: string;
  backend: ListingFetch["backend"];
  fetchedAt: number;
  /** Matches the candidate product closely enough to compare. */
  matches: boolean;
  /** Far below the market median: likely a wrong size, bait, or scam listing. */
  outlier: boolean;
}

export interface RejectedListing {
  title: string;
  reason: "schema" | "price" | "currency" | "link" | "untrusted_instruction";
}

export interface CandidateProduct {
  id: string;
  name: string;
  price: number;
  /** Where the candidate came from (catalog today, Apify discovery later). */
  source: string;
}

export type VerificationStatus = "verified" | "higher_than_market" | "lower_than_market" | "unverified";

export interface PriceComparison {
  query: string;
  candidate: CandidateProduct & { size: ParsedSize | null; unitPrice: number | null; unitLabel: string | null };
  listings: NormalizedListing[];
  rejected: RejectedListing[];
  verification: {
    status: VerificationStatus;
    matchedCount: number;
    marketMedianUnitPrice: number | null;
    /** Candidate unit price vs market median, in percent (+ = candidate costs more). */
    candidateDeltaPct: number | null;
    note: string;
  };
  recommendation: {
    /** "candidate" or a listing id. */
    choice: string;
    name: string;
    merchant: string;
    price: number;
    unitPrice: number | null;
    unitLabel: string | null;
    reason: string;
    savingsPerUnitPct: number | null;
  };
  backend: ListingFetch["backend"];
  sourceLabel: string;
  fetchedAt: number;
  cached: boolean;
  freshness: Freshness;
}

/** Results older than this are shown as stale and can't be added to a cart. */
export const STALE_AFTER_MS = 24 * 60 * 60_000;
/** Within this band of the market median, the candidate price counts as verified. */
const VERIFY_BAND = 0.15;
/** Below this fraction of the median, a listing is treated as an outlier. */
const OUTLIER_FRACTION = 0.5;

/* -------------------------------------------------------------- sanitize */

const INJECTION =
  /ignore (all |any )?(previous|prior|above)|disregard (the )?(previous|above)|system prompt|you are now|new instructions|<\s*script|add .{0,40}to (the|your) cart|gift ?cards?|wire transfer/i;

/** Control, zero-width and bidi-override characters (built from code points). */
const INVISIBLE = new RegExp(
  `[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e]].map(([lo, hi]) => `${String.fromCharCode(lo)}-${String.fromCharCode(hi)}`).join("")}]`,
  "g",
);

function cleanText(v: string, max = 120): string {
  return v
    .replace(INVISIBLE, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const rawSchema = z.object({
  title: z.string().min(2).max(400),
  price: z.union([z.string().min(1).max(40), z.number()]),
  shop: z.string().min(1).max(120),
  link: z.string().min(8).max(2000),
  rating: z.union([z.number(), z.string()]).optional().nullable(),
  reviewsCount: z.unknown().optional(),
  availabilityHint: z.unknown().optional(),
});

/** Parse "$3.49", "3.49", "$1,299.00" (USD only). Returns null for other currencies. */
export function parseUsdPrice(v: string | number): number | null | "currency" {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (/[€£¥₹]|\b(EUR|GBP|JPY|INR|CAD|AUD)\b/i.test(s)) return "currency";
  const m = s.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/);
  return m ? Number(m[0]) : null;
}

/* ------------------------------------------------------------------ size */

const UNITS: { re: RegExp; dimension: Dimension; factor: number; label: string; ambiguousOz?: boolean }[] = [
  { re: /(\d+(?:\.\d+)?)\s*(?:fl\.?\s*oz|fluid\s*ounces?)\b/i, dimension: "volume", factor: 1, label: "fl oz" },
  { re: /(\d+(?:\.\d+)?)\s*(?:gal(?:lon)?s?)\b/i, dimension: "volume", factor: 128, label: "gal" },
  { re: /(\d+(?:\.\d+)?)\s*(?:qts?|quarts?)\b/i, dimension: "volume", factor: 32, label: "qt" },
  { re: /(\d+(?:\.\d+)?)\s*(?:liters?|litres?|l)\b/i, dimension: "volume", factor: 33.814, label: "L" },
  { re: /(\d+(?:\.\d+)?)\s*ml\b/i, dimension: "volume", factor: 0.033814, label: "mL" },
  { re: /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/i, dimension: "weight", factor: 16, label: "lb" },
  { re: /(\d+(?:\.\d+)?)\s*kg\b/i, dimension: "weight", factor: 35.274, label: "kg" },
  { re: /(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/i, dimension: "weight", factor: 0.035274, label: "g" },
  { re: /(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/i, dimension: "weight", factor: 1, label: "oz", ambiguousOz: true },
  { re: /(\d+)\s*(?:ct|count|pk|pack|-pack)\b/i, dimension: "count", factor: 1, label: "ct" },
];

/** Extract a comparable size from a product title. Null when none is stated. */
export function parseSize(title: string): ParsedSize | null {
  const t = title.toLowerCase();
  if (/half[\s-]?gal/.test(t)) return { dimension: "volume", quantity: 64, label: "half gal" };
  for (const u of UNITS) {
    const m = t.match(u.re);
    if (m) {
      const n = Number(m[1]);
      if (!(n > 0)) continue;
      return { dimension: u.dimension, quantity: n * u.factor, label: `${n} ${u.label}`, ...(u.ambiguousOz ? { ambiguousOz: true } : {}) };
    }
  }
  if (/\bdozen\b/.test(t)) return { dimension: "count", quantity: 12, label: "dozen" };
  // "1 gallon" with no number written ("Milk, Gallon") still means one gallon.
  if (/\bgallon\b/.test(t)) return { dimension: "volume", quantity: 128, label: "1 gal" };
  return null;
}

const BASE_UNIT: Record<Dimension, string> = { volume: "fl oz", weight: "oz", count: "item" };

/** Put a listing's size on the same dimension as the candidate where that is safe. */
function alignSize(size: ParsedSize | null, target: Dimension | undefined): ParsedSize | null {
  if (!size || !target) return size;
  if (size.dimension === target) return size;
  // Liquids are often sold as "64 oz": treat a bare oz as fluid ounces for volume items.
  if (target === "volume" && size.ambiguousOz) return { ...size, dimension: "volume" };
  return size;
}

function unitPriceOf(price: number, size: ParsedSize | null): number | null {
  return size && size.quantity > 0 ? round(price / size.quantity, 4) : null;
}

/* -------------------------------------------------------------- matching */

const STOP = new Set(["and", "the", "with", "for", "of", "a", "fresh", "large", "grade", "whole", "pack", "ct", "count", "loaf", "bag", "bunch", "dozen", "gal", "gallon", "oz", "fl", "lb", "lbs"]);

function keyTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?\s*(fl\.?\s*oz|oz|gal(lon)?s?|lbs?|ct|count|qt|ml|l|kg|g)\b/g, " ")
    .split(/[^a-z0-9%]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

/** Does a listing describe the same kind of product as the candidate? */
export function listingMatches(candidateName: string, listingTitle: string): boolean {
  const want = keyTokens(candidateName);
  if (!want.length) return false;
  const have = new Set(keyTokens(listingTitle));
  // Also accept simple plurals/singulars ("egg" vs "eggs").
  const hit = want.filter((w) => have.has(w) || have.has(`${w}s`) || (w.endsWith("s") && have.has(w.slice(0, -1))));
  return hit.length / want.length >= 0.6;
}

/* -------------------------------------------------------------- freshness */

export interface Freshness {
  label: string;
  stale: boolean;
  ageMs: number;
}

export function freshnessOf(fetchedAt: number, now = Date.now()): Freshness {
  const ageMs = Math.max(0, now - fetchedAt);
  const min = Math.round(ageMs / 60_000);
  const label =
    min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 60 * 24 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
  return { label, stale: ageMs > STALE_AFTER_MS, ageMs };
}

/* ------------------------------------------------------------- normalize */

export function normalizeListings(
  fetch: ListingFetch,
  candidateName: string,
): { listings: NormalizedListing[]; rejected: RejectedListing[] } {
  const listings: NormalizedListing[] = [];
  const rejected: RejectedListing[] = [];
  const candidateDim = parseSize(candidateName)?.dimension;

  fetch.listings.forEach((raw: RawListing, i) => {
    const parsed = rawSchema.safeParse(raw);
    const titleForLog = typeof raw.title === "string" ? cleanText(raw.title, 60) : "(untitled)";
    if (!parsed.success) return void rejected.push({ title: titleForLog, reason: "schema" });
    const r = parsed.data;

    if (INJECTION.test(r.title) || INJECTION.test(r.shop)) {
      return void rejected.push({ title: titleForLog, reason: "untrusted_instruction" });
    }
    const price = parseUsdPrice(r.price);
    if (price === "currency") return void rejected.push({ title: titleForLog, reason: "currency" });
    if (price === null || !(price > 0) || price > 1000) return void rejected.push({ title: titleForLog, reason: "price" });
    let link: URL;
    try {
      link = new URL(r.link);
    } catch {
      return void rejected.push({ title: titleForLog, reason: "link" });
    }
    if (link.protocol !== "https:" && link.protocol !== "http:") return void rejected.push({ title: titleForLog, reason: "link" });

    const title = cleanText(r.title);
    const size = alignSize(parseSize(title), candidateDim);
    const comparable = !!size && (!candidateDim || size.dimension === candidateDim);
    const hint = typeof r.availabilityHint === "string" ? r.availabilityHint.toLowerCase() : "";
    const ratingNum = r.rating == null ? null : Number(r.rating);

    listings.push({
      id: `l${i + 1}`,
      title,
      merchant: cleanText(r.shop, 60),
      price: round(price, 2),
      currency: "USD",
      size: comparable ? size : null,
      unitPrice: comparable ? unitPriceOf(price, size) : null,
      unitLabel: comparable && size ? BASE_UNIT[size.dimension] : null,
      availability: /out of stock|sold out|unavailable/.test(hint) ? "out_of_stock" : /in stock|available/.test(hint) ? "in_stock" : "unknown",
      link: link.toString(),
      rating: ratingNum !== null && Number.isFinite(ratingNum) && ratingNum >= 0 && ratingNum <= 5 ? ratingNum : null,
      source: fetch.sourceLabel,
      backend: fetch.backend,
      fetchedAt: fetch.fetchedAt,
      matches: listingMatches(candidateName, title) && comparable,
      outlier: false,
    });
  });

  // Flag outliers against the median of comparable matches.
  const median = medianOf(listings.filter((l) => l.matches && l.unitPrice !== null).map((l) => l.unitPrice as number));
  if (median !== null) {
    for (const l of listings) if (l.matches && l.unitPrice !== null && l.unitPrice < median * OUTLIER_FRACTION) l.outlier = true;
  }
  return { listings, rejected };
}

/* --------------------------------------------------------------- compare */

export function comparePrices(candidate: CandidateProduct, fetch: ListingFetch, now = Date.now()): PriceComparison {
  const { listings, rejected } = normalizeListings(fetch, candidate.name);
  const cSize = parseSize(candidate.name);
  const cUnit = unitPriceOf(candidate.price, cSize);
  const cUnitLabel = cSize ? BASE_UNIT[cSize.dimension] : null;
  const freshness = freshnessOf(fetch.fetchedAt, now);

  const trusted = listings.filter((l) => l.matches && !l.outlier && l.unitPrice !== null);
  const median = medianOf(trusted.map((l) => l.unitPrice as number));

  let status: VerificationStatus = "unverified";
  let delta: number | null = null;
  let note: string;
  if (cUnit === null) {
    note = "The candidate has no stated size, so its price can't be compared per unit.";
  } else if (trusted.length < 2 || median === null) {
    note = trusted.length ? "Only one comparable public listing was found; not enough to verify." : "No comparable public listings were found.";
  } else {
    delta = round(((cUnit - median) / median) * 100, 1);
    status = Math.abs(delta) <= VERIFY_BAND * 100 ? "verified" : delta > 0 ? "higher_than_market" : "lower_than_market";
    note =
      status === "verified"
        ? `In line with ${trusted.length} public listings (within ${VERIFY_BAND * 100}% of the median).`
        : status === "higher_than_market"
          ? `About ${Math.abs(delta)}% above the median of ${trusted.length} public listings.`
          : `About ${Math.abs(delta)}% below the median of ${trusted.length} public listings.`;
  }
  if (freshness.stale) note += " These listings are over a day old.";

  // Recommend the best unit price among usable listings; the candidate wins ties.
  const usable = freshness.stale ? [] : trusted.filter((l) => l.availability !== "out_of_stock");
  const best = usable.reduce<NormalizedListing | null>((b, l) => (!b || (l.unitPrice as number) < (b.unitPrice as number) ? l : b), null);
  const listingWins = best && (cUnit === null || (best.unitPrice as number) < cUnit * 0.98);
  const recommendation: PriceComparison["recommendation"] =
    best && listingWins
      ? {
          choice: best.id,
          name: best.title,
          merchant: best.merchant,
          price: best.price,
          unitPrice: best.unitPrice,
          unitLabel: best.unitLabel,
          savingsPerUnitPct: cUnit ? round(((cUnit - (best.unitPrice as number)) / cUnit) * 100, 1) : null,
          reason: `Lowest price per ${best.unitLabel} among ${usable.length} available matching listing(s)${best.size ? ` (${best.size.label})` : ""}.`,
        }
      : {
          choice: "candidate",
          name: candidate.name,
          merchant: candidate.source,
          price: candidate.price,
          unitPrice: cUnit,
          unitLabel: cUnitLabel,
          savingsPerUnitPct: 0,
          reason: usable.length
            ? "Your usual product is already the best value per unit among available listings."
            : "No better verified public listing was available, so keeping your usual product.",
        };

  // Show trusted matches first by unit price, then everything else.
  const order = (l: NormalizedListing) => (l.matches && !l.outlier && l.unitPrice !== null ? 0 : 1);
  listings.sort((a, b) => order(a) - order(b) || (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity));

  return {
    query: fetch.query,
    candidate: { ...candidate, size: cSize, unitPrice: cUnit, unitLabel: cUnitLabel },
    listings,
    rejected,
    verification: { status, matchedCount: trusted.length, marketMedianUnitPrice: median, candidateDeltaPct: delta, note },
    recommendation,
    backend: fetch.backend,
    sourceLabel: fetch.sourceLabel,
    fetchedAt: fetch.fetchedAt,
    cached: fetch.cached,
    freshness,
  };
}

function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, 4);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
