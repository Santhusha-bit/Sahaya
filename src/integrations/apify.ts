/**
 * Apify: product search for Care's shopping workflow.
 *
 * Live with APIFY_TOKEN: runs an Apify Actor synchronously and reads its dataset
 * items (POST /v2/actors/{actor}/run-sync-get-dataset-items, Bearer token). The
 * default Actor is Apify's official `apify~e-commerce-scraping-tool`, called with
 * its keyword-search input (`keyword`, `marketplaces`, `maxProductResults`).
 * Override with APIFY_ACTOR_ID / APIFY_MARKETPLACES. Result items are normalized
 * defensively because Actor output shapes vary (name|title, offers.price|price).
 *
 * Without a token, a sandbox catalog with the same interface is used. Each
 * candidate carries `source` so the cart can say honestly where a price came from.
 * A failed or empty live search for one item falls back to the sandbox catalog
 * for that item only, and is reported, never silently mixed.
 */

import { apifyStatus } from "@/lib/env";
import type { ProductCandidate } from "@/agents/care/shopping/types";

export interface ProductQuery {
  query: string;
  category: string;
  limit?: number;
}

export interface ProductSearchProvider {
  readonly backend: "apify" | "sandbox";
  search(q: ProductQuery): Promise<ProductCandidate[]>;
}

/* ------------------------------------------------------------------ sandbox */

type SandboxRow = Omit<ProductCandidate, "source">;

/** Small store catalog. Stock levels are chosen to exercise the substitution policy. */
export const SANDBOX_CATALOG: SandboxRow[] = [
  { productId: "sb_milk_clover", name: "Clover Organic 2% Milk", brand: "Clover", size: "1 gal", price: 5.49, category: "dairy", tags: ["milk", "2%", "organic"], inStock: false },
  { productId: "sb_milk_ov", name: "Organic Valley 2% Reduced Fat Milk", brand: "Organic Valley", size: "1 gal", price: 5.89, category: "dairy", tags: ["milk", "2%", "organic"], inStock: true },
  { productId: "sb_milk_lucerne", name: "Lucerne 2% Milk", brand: "Lucerne", size: "1 gal", price: 3.99, category: "dairy", tags: ["milk", "2%"], inStock: true },
  { productId: "sb_milk_horizon_skim", name: "Horizon Organic Skim Milk", brand: "Horizon", size: "1 gal", price: 5.29, category: "dairy", tags: ["milk", "skim", "organic"], inStock: true },
  { productId: "sb_bread_daves", name: "Dave's Killer Bread 21 Whole Grains", brand: "Dave's Killer Bread", size: "27 oz", price: 5.99, category: "bakery", tags: ["bread", "whole wheat"], inStock: true },
  { productId: "sb_bread_wonder", name: "Wonder Classic White Bread", brand: "Wonder", size: "20 oz", price: 3.29, category: "bakery", tags: ["bread", "white"], inStock: true },
  { productId: "sb_eggs_vital", name: "Vital Farms Pasture-Raised Large Eggs", brand: "Vital Farms", size: "12 ct", price: 6.49, category: "dairy", tags: ["eggs", "large"], inStock: true },
  { productId: "sb_eggs_store", name: "Store Brand Large Eggs", brand: "Store Brand", size: "12 ct", price: 3.49, category: "dairy", tags: ["eggs", "large"], inStock: true },
  { productId: "sb_bananas", name: "Bananas", size: "about 2.5 lb bunch", price: 1.89, category: "produce", tags: ["bananas", "fruit"], inStock: true },
  { productId: "sb_oats_quaker", name: "Quaker Old Fashioned Rolled Oats", brand: "Quaker", size: "42 oz", price: 4.79, category: "pantry", tags: ["oats", "breakfast"], inStock: true },
  { productId: "sb_soup_pacific", name: "Pacific Foods Organic Light Sodium Vegetable Soup", brand: "Pacific Foods", size: "32 oz", price: 3.99, category: "pantry", tags: ["soup", "vegetable", "low-sodium"], inStock: true },
  { productId: "sb_soup_campbells", name: "Campbell's Condensed Vegetable Soup", brand: "Campbell's", size: "10.5 oz", price: 1.99, category: "pantry", tags: ["soup", "vegetable", "high-sodium"], inStock: true },
  { productId: "sb_yogurt_fage", name: "Fage Total 2% Plain Greek Yogurt", brand: "Fage", size: "32 oz", price: 5.29, category: "dairy", tags: ["yogurt", "greek", "plain"], inStock: false },
  { productId: "sb_yogurt_chobani", name: "Chobani Plain Greek Yogurt", brand: "Chobani", size: "32 oz", price: 5.49, category: "dairy", tags: ["yogurt", "greek", "plain"], inStock: true },
  { productId: "sb_cookies", name: "Walkers Pure Butter Shortbread", brand: "Walkers", size: "5.3 oz", price: 3.99, category: "snacks", tags: ["cookies", "shortbread"], inStock: true },
];

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9%]+/).filter((w) => w.length > 1);
}

export class SandboxProductSearch implements ProductSearchProvider {
  readonly backend = "sandbox" as const;
  async search(q: ProductQuery): Promise<ProductCandidate[]> {
    const terms = words(q.query);
    // Require at least half the query terms so a "2%" yogurt never answers a milk search.
    const needed = Math.max(1, Math.ceil(terms.length / 2));
    const scored = SANDBOX_CATALOG.filter((p) => p.category === q.category)
      .map((p) => {
        const hay = words(`${p.name} ${p.size ?? ""} ${p.tags.join(" ")}`);
        const score = terms.filter((t) => hay.some((h) => h === t || h.startsWith(t) || t.startsWith(h))).length;
        return { p, score };
      })
      .filter((s) => s.score >= needed)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, q.limit ?? 8).map(({ p }) => ({ ...p, source: "sandbox" as const }));
  }
}

/* --------------------------------------------------------------------- live */

/** Derive policy-relevant tags from free-text product names. */
export function tagsFromText(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  if (/(low|lower|less|reduced|light)[\s-]+(in[\s-]+)?sodium|no salt added|unsalted/.test(t)) tags.push("low-sodium");
  if (/organic/.test(t)) tags.push("organic");
  if (/\bskim\b|fat[\s-]free|nonfat/.test(t)) tags.push("skim");
  if (/spicy|hot\b|jalape/.test(t)) tags.push("spicy");
  if (/sugar[\s-]free/.test(t)) tags.push("sugar-free");
  return tags;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Normalize one Actor dataset item into a candidate, or null if unusable. */
export function normalizeApifyItem(raw: unknown, category: string, index: number): ProductCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const product = (r.product && typeof r.product === "object" ? r.product : {}) as Record<string, any>;
  const name = str(r.name) ?? str(r.title) ?? str(product.title) ?? str(product.name);
  const offers = Array.isArray(r.offers) ? r.offers[0] : r.offers;
  const price = num(offers?.price) ?? num(r.price) ?? num(product.price) ?? num(r.currentPrice);
  if (!name || price === null || price <= 0) return null;
  const brand = str(typeof r.brand === "object" ? r.brand?.name : r.brand) ?? str(product.brand);
  const url = str(r.url) ?? str(product.url);
  const availability = String(offers?.availability ?? r.availability ?? r.inStock ?? "").toLowerCase();
  const inStock = !/outofstock|out of stock|unavailable|false|sold out/.test(availability);
  const image = Array.isArray(r.image) ? str(r.image[0]) : str(r.image) ?? str(r.thumbnail);
  return {
    productId: `apify_${str(r.sku) ?? str(r.id) ?? str(r.asin) ?? `${index}_${name.slice(0, 24).replace(/\W+/g, "_")}`}`,
    name,
    brand,
    price: Math.round(price * 100) / 100,
    category,
    tags: tagsFromText(`${name} ${str(r.description) ?? ""}`),
    inStock,
    source: "apify",
    url,
    image,
  };
}

export class ApifyProductSearch implements ProductSearchProvider {
  readonly backend = "apify" as const;
  constructor(
    private readonly token: string,
    private readonly actorId: string = process.env.APIFY_ACTOR_ID?.trim() || "apify~e-commerce-scraping-tool",
    private readonly timeoutMs: number = Number(process.env.APIFY_TIMEOUT_MS) || 60_000,
  ) {}

  async search(q: ProductQuery): Promise<ProductCandidate[]> {
    const marketplaces = (process.env.APIFY_MARKETPLACES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const input: Record<string, unknown> = { keyword: q.query, maxProductResults: q.limit ?? 8 };
    if (marketplaces.length) input.marketplaces = marketplaces;
    const runTimeoutSecs = Math.max(10, Math.floor(this.timeoutMs / 1000) - 5);
    const url = `https://api.apify.com/v2/actors/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items?timeout=${runTimeoutSecs}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Apify ${res.status}: ${body.slice(0, 200)}`);
    }
    const items = (await res.json()) as unknown;
    if (!Array.isArray(items)) throw new Error("Apify returned a non-array dataset");
    return items
      .map((it, i) => normalizeApifyItem(it, q.category, i))
      .filter((c): c is ProductCandidate => c !== null);
  }
}

export function getProductSearchProvider(): ProductSearchProvider {
  const token = process.env.APIFY_TOKEN?.trim();
  return token && apifyStatus().mode === "live" ? new ApifyProductSearch(token) : new SandboxProductSearch();
}

export interface ItemSearchResult {
  candidates: ProductCandidate[];
  backend: "apify" | "sandbox";
  /** Set when the live search failed or was empty and the sandbox catalog was used. */
  fallbackReason?: string;
}

/**
 * Search for one item. If live Apify fails or finds nothing, fall back to the
 * sandbox catalog for this item and record why, so nothing is silently mixed.
 */
export async function searchItem(
  q: ProductQuery,
  provider: ProductSearchProvider = getProductSearchProvider(),
): Promise<ItemSearchResult> {
  if (provider.backend === "sandbox") return { candidates: await provider.search(q), backend: "sandbox" };
  try {
    const live = await provider.search(q);
    if (live.length) return { candidates: live, backend: "apify" };
    return { candidates: await new SandboxProductSearch().search(q), backend: "sandbox", fallbackReason: "no live results" };
  } catch (err) {
    return {
      candidates: await new SandboxProductSearch().search(q),
      backend: "sandbox",
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }
}
