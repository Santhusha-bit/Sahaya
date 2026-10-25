/**
 * Open Food Facts + Open Prices source.
 *
 * Both are open-data projects whose public APIs explicitly permit reuse
 * (ODbL), so no retailer site is scraped and no terms of service are bypassed.
 *   1. Open Food Facts search finds products whose names match the query.
 *   2. Open Prices returns real shelf / receipt prices reported at named stores
 *      (Walmart, Safeway, Whole Foods, Costco, ...) for those barcodes.
 *   3. Raw produce without barcodes (bananas, apples) is priced by category.
 *
 * Availability is derived from how recently the price was observed, never
 * claimed as live stock.
 */

import { fetchJson } from "../http";
import { categoryTagsFor, humanizeTag, matchScore } from "../match";
import type { Availability, FetchLike, PricePer, ProductOffer, ShoppingItem } from "../types";

const OFF_SEARCH = "https://search.openfoodfacts.org/search";
const PRICES_API = "https://prices.openfoodfacts.org/api/v1/prices";
const PRICES_WEB = "https://prices.openfoodfacts.org";
const OFF_WEB = "https://world.openfoodfacts.org";

/** ISO country -> Open Food Facts country tag + default currency. */
export const COUNTRIES: Record<string, { tag: string; currency: string }> = {
  us: { tag: "en:united-states", currency: "USD" },
  ca: { tag: "en:canada", currency: "CAD" },
  gb: { tag: "en:united-kingdom", currency: "GBP" },
  ie: { tag: "en:ireland", currency: "EUR" },
  fr: { tag: "en:france", currency: "EUR" },
  de: { tag: "en:germany", currency: "EUR" },
  es: { tag: "en:spain", currency: "EUR" },
  it: { tag: "en:italy", currency: "EUR" },
  nl: { tag: "en:netherlands", currency: "EUR" },
  be: { tag: "en:belgium", currency: "EUR" },
  ch: { tag: "en:switzerland", currency: "CHF" },
  au: { tag: "en:australia", currency: "AUD" },
  in: { tag: "en:india", currency: "INR" },
};

const RECENT_DAYS = 45;
const MIN_MATCH = 0.45;

interface OffHit {
  code?: string;
  product_name?: string;
  brands?: string[] | string;
  quantity?: string;
  image_front_small_url?: string;
  categories_tags?: string[];
}

interface PriceRow {
  id: number;
  type?: "PRODUCT" | "CATEGORY";
  product_code?: string | null;
  product_name?: string | null;
  category_tag?: string | null;
  price?: number | null;
  price_is_discounted?: boolean;
  price_without_discount?: number | null;
  price_per?: string | null;
  currency?: string;
  date?: string;
  location_id?: number | null;
  product?: { product_name?: string | null; brands?: string | null; quantity?: string | null; image_url?: string | null } | null;
  location?: { osm_name?: string | null; osm_brand?: string | null; osm_address_city?: string | null; osm_address_country_code?: string | null } | null;
}

export interface OpenPricesOptions {
  country: string;
  currency: string;
  maxPriceAgeDays: number;
  retailer?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  includeUnpriced: boolean;
  now: Date;
}

function firstBrand(brands: OffHit["brands"] | string | null | undefined): string | null {
  const list = Array.isArray(brands) ? brands : typeof brands === "string" ? brands.split(",") : [];
  const b = list.map((s) => s.trim()).find(Boolean);
  return b ?? null;
}

function pricePer(raw: string | null | undefined): PricePer | null {
  switch ((raw ?? "").toUpperCase()) {
    case "KILOGRAM":
      return "kilogram";
    case "LITER":
    case "LITRE":
      return "liter";
    case "POUND":
      return "pound";
    case "UNIT":
      return "unit";
    default:
      return null;
  }
}

export function availabilityFromDate(date: string | null | undefined, now: Date): Availability {
  if (!date) return "unknown";
  const ageDays = (now.getTime() - new Date(date).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays)) return "unknown";
  return ageDays <= RECENT_DAYS ? "recently_seen" : "previously_seen";
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function priceParams(opts: OpenPricesOptions): URLSearchParams {
  const p = new URLSearchParams({
    currency: opts.currency,
    order_by: "-date",
    size: "100",
    date__gte: isoDaysAgo(opts.now, opts.maxPriceAgeDays),
  });
  if (opts.retailer) p.set("location__osm_name__contains", opts.retailer);
  if (opts.latitude != null && opts.longitude != null) {
    p.set("lat", String(opts.latitude));
    p.set("lon", String(opts.longitude));
    p.set("radius_km", String(opts.radiusKm ?? 25));
  }
  return p;
}

/** Map one Open Prices row into a normalized offer (rank assigned later). */
export function offerFromPriceRow(row: PriceRow, item: ShoppingItem, nowIso: string, now: Date, fallback?: OffHit): ProductOffer | null {
  if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) return null;
  const name =
    row.product?.product_name?.trim() ||
    row.product_name?.trim() ||
    fallback?.product_name?.trim() ||
    (row.category_tag ? humanizeTag(row.category_tag) : "");
  if (!name) return null;
  const brand = firstBrand(row.product?.brands) ?? firstBrand(fallback?.brands);
  const city = row.location?.osm_address_city?.trim();
  const cc = row.location?.osm_address_country_code?.trim();
  return {
    offerId: `open-prices:${row.product_code ?? row.category_tag ?? "x"}:${row.location_id ?? "x"}`,
    query: item.query,
    quantity: item.quantity,
    rank: 0,
    productName: name,
    brand,
    size: row.product?.quantity?.trim() || fallback?.quantity?.trim() || null,
    gtin: row.product_code ?? null,
    price: Number(row.price.toFixed(2)),
    currency: row.currency ?? null,
    pricePer: pricePer(row.price_per) ?? (row.type === "PRODUCT" || row.product_code ? "unit" : null),
    regularPrice: typeof row.price_without_discount === "number" ? row.price_without_discount : null,
    isDiscounted: !!row.price_is_discounted,
    availability: availabilityFromDate(row.date, now),
    priceObservedAt: row.date ?? null,
    retailer: row.location?.osm_brand?.trim() || row.location?.osm_name?.trim() || null,
    storeLocation: [city, cc].filter(Boolean).join(", ") || null,
    source: "open-prices",
    sourceUrl: `${PRICES_WEB}/prices/${row.id}`,
    productUrl: row.product_code ? `${PRICES_WEB}/products/${row.product_code}` : null,
    imageUrl: row.product?.image_url ?? fallback?.image_front_small_url ?? null,
    matchScore: matchScore(item.query, name, brand),
    retrievedAt: nowIso,
  };
}

/** Keep only the most recent observation per product+store. Rows arrive newest first. */
function latestPerStore(rows: PriceRow[]): PriceRow[] {
  const seen = new Set<string>();
  const out: PriceRow[] = [];
  for (const r of rows) {
    const key = `${r.product_code ?? r.category_tag}|${r.location_id ?? "none"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export async function searchOpenPrices(
  fetchImpl: FetchLike,
  item: ShoppingItem,
  opts: OpenPricesOptions,
): Promise<{ offers: ProductOffer[]; warnings: string[] }> {
  const nowIso = opts.now.toISOString();
  const country = COUNTRIES[opts.country] ?? COUNTRIES.us;
  const warnings: string[] = [];

  // 1) Product candidates from Open Food Facts, scoped to the country.
  const q = `${item.query} countries_tags:"${country.tag}"`;
  const searchUrl = `${OFF_SEARCH}?${new URLSearchParams({
    q,
    page_size: "100",
    fields: "code,product_name,brands,quantity,image_front_small_url,categories_tags",
  })}`;
  const search = await fetchJson<{ hits?: OffHit[] }>(fetchImpl, { url: searchUrl });
  const candidates = (search.hits ?? [])
    .filter((h): h is OffHit & { code: string } => !!h.code && /^\d{6,14}$/.test(h.code) && !!h.product_name)
    .map((h) => ({ hit: h, score: matchScore(item.query, h.product_name ?? "", firstBrand(h.brands)) }))
    .filter((c) => c.score >= MIN_MATCH)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
  const byCode = new Map(candidates.map((c) => [c.hit.code, c.hit]));

  const offers: ProductOffer[] = [];

  // 2) Prices for those barcodes at real stores.
  if (candidates.length) {
    const p = priceParams(opts);
    p.set("product_code__in", candidates.map((c) => c.hit.code).join(","));
    const rows = await fetchJson<{ items?: PriceRow[] }>(fetchImpl, { url: `${PRICES_API}?${p}` });
    for (const row of latestPerStore(rows.items ?? [])) {
      const o = offerFromPriceRow(row, item, nowIso, opts.now, row.product_code ? byCode.get(row.product_code) : undefined);
      if (o && o.matchScore >= MIN_MATCH) offers.push(o);
    }
  }

  // 3) Category-priced raw products (produce, bulk) when barcodes yield little.
  if (offers.length < 3) {
    for (const tag of categoryTagsFor(item.query)) {
      const p = priceParams(opts);
      p.set("category_tag", tag);
      try {
        const rows = await fetchJson<{ items?: PriceRow[] }>(fetchImpl, { url: `${PRICES_API}?${p}`, retries: 1 });
        for (const row of latestPerStore(rows.items ?? [])) {
          const o = offerFromPriceRow(row, item, nowIso, opts.now);
          // Category rows are already scoped by tag; score against the tag label as a floor.
          if (o) offers.push({ ...o, matchScore: Math.max(o.matchScore, matchScore(item.query, humanizeTag(tag))) });
        }
      } catch (err) {
        warnings.push(`category lookup ${tag} failed: ${(err as Error).message}`);
      }
      if (offers.length >= 3) break;
    }
  }

  // 4) Matching products with no recent price, so the list still resolves.
  if (opts.includeUnpriced) {
    const priced = new Set(offers.map((o) => o.gtin).filter(Boolean));
    for (const { hit, score } of candidates.slice(0, 5)) {
      if (priced.has(hit.code)) continue;
      offers.push({
        offerId: `open-food-facts:${hit.code}`,
        query: item.query,
        quantity: item.quantity,
        rank: 0,
        productName: hit.product_name!.trim(),
        brand: firstBrand(hit.brands),
        size: hit.quantity?.trim() || null,
        gtin: hit.code,
        price: null,
        currency: null,
        pricePer: null,
        regularPrice: null,
        isDiscounted: false,
        availability: "unknown",
        priceObservedAt: null,
        retailer: null,
        storeLocation: null,
        source: "open-prices",
        sourceUrl: `${OFF_WEB}/product/${hit.code}`,
        productUrl: `${PRICES_WEB}/products/${hit.code}`,
        imageUrl: hit.image_front_small_url ?? null,
        matchScore: score,
        retrievedAt: nowIso,
      });
    }
  }

  return { offers, warnings };
}
