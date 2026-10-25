/**
 * Apify: live grocery product discovery for the Care agent.
 *
 * Care sends a shopping list to the Grocery Product Discovery Actor
 * (actors/grocery-product-discovery) and gets back normalized product offers:
 * names, prices, availability indicators and source URLs.
 *
 * Three backends behind one interface, chosen honestly:
 *   - "apify"   APIFY_TOKEN + APIFY_GROCERY_ACTOR_ID set: starts a real Actor run
 *               on the Apify platform, waits for it, then reads its dataset and
 *               OUTPUT record. The run id and Console URL are returned as proof.
 *   - "local"   no Apify credentials: the Actor's own discovery code runs
 *               in-process against the same permitted open-data APIs. Real
 *               prices, but NOT an Apify run, and labeled that way.
 *   - "sandbox" offline fixture catalog (tests, no network). Same ranking code.
 *
 * Everything the Actor returns is untrusted web data. It is schema-validated and
 * sanitized here (text cleaned, injection-like names withheld, URLs restricted to
 * the Actor's known source hosts, prices bounded) before any agent or model sees it.
 */

import { z } from "zod";
import {
  compareOffers,
  discoverProducts,
  matchScore,
  parseShoppingList,
  summarizeItem,
  type ItemSummary,
  type ProductOffer,
  type ShoppingItem,
} from "../../actors/grocery-product-discovery/src/core/discover";

export type { ItemSummary, ProductOffer } from "../../actors/grocery-product-discovery/src/core/discover";

export type DiscoveryBackend = "apify" | "local" | "sandbox";

export interface ApifyRunInfo {
  runId: string;
  actorId: string;
  status: string;
  datasetId: string;
  keyValueStoreId: string;
  startedAt: string | null;
  finishedAt: string | null;
  consoleUrl: string;
}

export interface GroceryDiscovery {
  backend: DiscoveryBackend;
  items: ItemSummary[];
  offers: ProductOffer[];
  run: ApifyRunInfo | null;
  warnings: string[];
  /** Set when a preferred backend failed and a fallback produced these results. */
  fallbackFrom?: DiscoveryBackend;
  generatedAt: string;
}

export interface DiscoveryRequest {
  shoppingList: string[];
  maxResultsPerItem?: number;
  retailer?: string;
}

export interface GroceryDiscoveryProvider {
  readonly backend: DiscoveryBackend;
  discover(req: DiscoveryRequest): Promise<GroceryDiscovery>;
}

// ---------------------------------------------------------------------------
// Validation of untrusted Actor output
// ---------------------------------------------------------------------------

/** Hosts the Actor's sources publish URLs on. Anything else is dropped. */
const ALLOWED_URL_HOSTS = [/(^|\.)openfoodfacts\.org$/, /(^|\.)kroger\.com$/];

const INJECTION = /(ignore (all |any )?(previous|prior|above)|system prompt|you are now|disregard|instructions?:|<\/?script|assistant:|\{\{|\}\})/i;

export function cleanText(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const t = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return null;
    if (!ALLOWED_URL_HOSTS.some((re) => re.test(u.hostname))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

const AvailabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock", "recently_seen", "previously_seen", "unknown"]);

const RawOfferSchema = z.object({
  offerId: z.string().min(1).max(200),
  query: z.string().min(1).max(120),
  quantity: z.number().int().min(1).max(99),
  rank: z.number().int().min(0).max(100),
  productName: z.string().min(1).max(500),
  brand: z.string().max(500).nullable(),
  size: z.string().max(200).nullable(),
  gtin: z.string().max(20).nullable(),
  price: z.number().positive().max(1000).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  pricePer: z.enum(["unit", "kilogram", "liter", "pound"]).nullable(),
  regularPrice: z.number().nonnegative().max(1000).nullable(),
  isDiscounted: z.boolean(),
  availability: AvailabilitySchema,
  priceObservedAt: z.string().max(40).nullable(),
  retailer: z.string().max(300).nullable(),
  storeLocation: z.string().max(300).nullable(),
  source: z.enum(["open-prices", "kroger"]),
  sourceUrl: z.string().max(2000),
  productUrl: z.string().max(2000).nullable(),
  imageUrl: z.string().max(2000).nullable(),
  matchScore: z.number().min(0).max(1),
  retrievedAt: z.string().max(40),
});

/**
 * Validate and sanitize one offer from the Actor. Returns null (offer dropped)
 * when the shape is wrong or the source URL is not on an allowed host. A product
 * name that looks like an instruction is kept out of the model's context.
 */
export function sanitizeOffer(raw: unknown): ProductOffer | null {
  const parsed = RawOfferSchema.safeParse(raw);
  if (!parsed.success) return null;
  const o = parsed.data;
  const sourceUrl = safeUrl(o.sourceUrl);
  if (!sourceUrl) return null;
  const name = cleanText(o.productName) ?? "";
  const suspicious = INJECTION.test(name) || INJECTION.test(o.brand ?? "");
  return {
    ...o,
    productName: suspicious ? "[product name withheld: failed safety check]" : name,
    brand: suspicious ? null : cleanText(o.brand, 60),
    size: cleanText(o.size, 40),
    retailer: cleanText(o.retailer, 80),
    storeLocation: cleanText(o.storeLocation, 80),
    sourceUrl,
    productUrl: safeUrl(o.productUrl),
    imageUrl: safeUrl(o.imageUrl),
    query: cleanText(o.query, 80) ?? o.query,
    // A withheld name can no longer be trusted as a match.
    matchScore: suspicious ? 0 : o.matchScore,
  };
}

/** Re-derive per-item summaries from sanitized offers so nothing unvalidated survives. */
function rebuild(items: ShoppingItem[], offers: ProductOffer[]): ItemSummary[] {
  return items.map((item) => {
    const mine = offers
      .filter((o) => o.query.toLowerCase() === item.query.toLowerCase() && o.matchScore > 0)
      .sort(compareOffers)
      .map((o, i) => ({ ...o, rank: i + 1 }));
    return summarizeItem(item, mine);
  });
}

// ---------------------------------------------------------------------------
// Apify platform backend
// ---------------------------------------------------------------------------

const APIFY_API = "https://api.apify.com/v2";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

interface ApifyRun {
  id: string;
  actId?: string;
  status: string;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export class ApifyGroceryDiscovery implements GroceryDiscoveryProvider {
  readonly backend = "apify" as const;
  private readonly actorPath: string;

  constructor(
    private readonly token: string,
    readonly actorId: string,
    private readonly opts: { fetch?: typeof fetch; maxWaitMs?: number; baseUrl?: string } = {},
  ) {
    // The API addresses Actors as "username~actor-name".
    this.actorPath = encodeURIComponent(actorId.trim().replace("/", "~"));
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? APIFY_API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Apify ${init?.method ?? "GET"} ${path.split("?")[0]} failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async discover(req: DiscoveryRequest): Promise<GroceryDiscovery> {
    const items = parseShoppingList(req.shoppingList);
    const input = {
      shoppingList: items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.query}` : i.query)),
      maxResultsPerItem: req.maxResultsPerItem ?? 5,
      ...(req.retailer ? { retailer: req.retailer } : {}),
    };

    // Start the run and wait (the API caps a single wait at 60s, so poll after).
    let { data: run } = await this.api<{ data: ApifyRun }>(`/acts/${this.actorPath}/runs?waitForFinish=60`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    const deadline = Date.now() + (this.opts.maxWaitMs ?? 150_000);
    while (!TERMINAL.has(run.status) && Date.now() < deadline) {
      ({ data: run } = await this.api<{ data: ApifyRun }>(`/actor-runs/${run.id}?waitForFinish=60`));
    }
    const runInfo: ApifyRunInfo = {
      runId: run.id,
      actorId: this.actorId,
      status: run.status,
      datasetId: run.defaultDatasetId,
      keyValueStoreId: run.defaultKeyValueStoreId,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      consoleUrl: `https://console.apify.com/view/runs/${run.id}`,
    };
    if (run.status !== "SUCCEEDED") {
      throw new Error(`Apify run ${run.id} ended with status ${run.status}`);
    }

    const rawOffers = await this.api<unknown[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=1000`);
    const output = await this.api<{ warnings?: unknown[] }>(`/key-value-stores/${run.defaultKeyValueStoreId}/records/OUTPUT`).catch(
      () => ({ warnings: [] as unknown[] }),
    );
    const offers = (Array.isArray(rawOffers) ? rawOffers : []).map(sanitizeOffer).filter((o): o is ProductOffer => !!o);
    const dropped = (Array.isArray(rawOffers) ? rawOffers.length : 0) - offers.length;
    const warnings = (output.warnings ?? []).map((w) => cleanText(w, 200)).filter((w): w is string => !!w);
    if (dropped > 0) warnings.push(`${dropped} offer(s) from the Actor failed validation and were dropped.`);

    return {
      backend: "apify",
      items: rebuild(items, offers),
      offers,
      run: runInfo,
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Local backend: the Actor's own core, run in-process
// ---------------------------------------------------------------------------

export class LocalGroceryDiscovery implements GroceryDiscoveryProvider {
  readonly backend = "local" as const;
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async discover(req: DiscoveryRequest): Promise<GroceryDiscovery> {
    const items = parseShoppingList(req.shoppingList);
    const result = await discoverProducts(
      { shoppingList: req.shoppingList, maxResultsPerItem: req.maxResultsPerItem ?? 5, retailer: req.retailer },
      { fetch: this.fetchImpl },
    );
    // Same validation path as Apify output: the data still came from the web.
    const offers = result.offers.map(sanitizeOffer).filter((o): o is ProductOffer => !!o);
    return {
      backend: "local",
      items: rebuild(items, offers),
      offers,
      run: null,
      warnings: result.warnings,
      generatedAt: result.generatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Sandbox backend: offline fixture catalog
// ---------------------------------------------------------------------------

interface FixtureProduct {
  name: string;
  brand: string;
  size: string;
  prices: [retailer: string, price: number, daysAgo: number][];
}

/** Offline catalog. Prices are illustrative fixtures, labeled sandbox everywhere. */
const FIXTURES: FixtureProduct[] = [
  { name: "Whole Milk", brand: "Lucerne", size: "1 gal", prices: [["Safeway", 4.49, 6], ["Walmart Supercenter", 3.68, 12]] },
  { name: "2% Reduced Fat Milk", brand: "Great Value", size: "1 gal", prices: [["Walmart Supercenter", 3.42, 9]] },
  { name: "Large Eggs", brand: "Vital Farms", size: "12 ct", prices: [["Whole Foods Market", 6.49, 4], ["Target", 6.99, 20]] },
  { name: "Grade A Large Eggs", brand: "Great Value", size: "12 ct", prices: [["Walmart Supercenter", 3.12, 7]] },
  { name: "Bananas", brand: "", size: "per lb", prices: [["Costco", 1.99, 15], ["Trader Joe's", 0.29, 3]] },
  { name: "100% Whole Wheat Bread", brand: "Dave's Killer Bread", size: "27 oz", prices: [["Safeway", 5.99, 10], ["Target", 5.49, 30]] },
  { name: "Old Fashioned Rolled Oats", brand: "Quaker", size: "42 oz", prices: [["Walmart Supercenter", 5.48, 14], ["Kroger", 5.99, 40]] },
  { name: "Boneless Skinless Chicken Breast", brand: "Foster Farms", size: "1.5 lb", prices: [["Safeway", 8.99, 5]] },
  { name: "Brown Rice", brand: "Mahatma", size: "2 lb", prices: [["Walmart Supercenter", 2.74, 21]] },
  { name: "Low Sodium Vegetable Soup", brand: "Progresso", size: "18.5 oz", prices: [["Target", 2.89, 11]] },
  { name: "Plain Greek Yogurt", brand: "Fage", size: "32 oz", prices: [["Whole Foods Market", 6.99, 8], ["Costco", 5.49, 25]] },
  { name: "Gala Apples", brand: "", size: "3 lb bag", prices: [["Trader Joe's", 3.99, 6], ["Safeway", 4.99, 13]] },
  { name: "Medium Roast Ground Coffee", brand: "Folgers", size: "25.4 oz", prices: [["Walmart Supercenter", 11.97, 18]] },
  { name: "Green Tea Bags", brand: "Bigelow", size: "40 ct", prices: [["Target", 4.29, 16]] },
  { name: "Sharp Cheddar Cheese", brand: "Tillamook", size: "8 oz", prices: [["Safeway", 4.79, 9]] },
  { name: "Salted Butter", brand: "Kerrygold", size: "8 oz", prices: [["Trader Joe's", 3.99, 5], ["Whole Foods Market", 4.49, 12]] },
  { name: "Orange Juice No Pulp", brand: "Tropicana", size: "52 oz", prices: [["Target", 4.99, 7]] },
  { name: "Roma Tomatoes", brand: "", size: "per lb", prices: [["Walmart Supercenter", 1.38, 4]] },
  { name: "Russet Potatoes", brand: "", size: "5 lb bag", prices: [["Safeway", 3.99, 10]] },
  { name: "Spaghetti Pasta", brand: "Barilla", size: "16 oz", prices: [["Target", 1.79, 22]] },
  { name: "Creamy Peanut Butter", brand: "Jif", size: "16 oz", prices: [["Walmart Supercenter", 2.98, 19]] },
  { name: "Toasted Oat Cereal", brand: "Cheerios", size: "18 oz", prices: [["Kroger", 4.99, 27]] },
];

export class SandboxGroceryDiscovery implements GroceryDiscoveryProvider {
  readonly backend = "sandbox" as const;
  constructor(private readonly now: () => Date = () => new Date()) {}

  async discover(req: DiscoveryRequest): Promise<GroceryDiscovery> {
    const items = parseShoppingList(req.shoppingList);
    const now = this.now();
    const offers: ProductOffer[] = [];
    for (const item of items) {
      const mine: ProductOffer[] = [];
      FIXTURES.forEach((p, pi) => {
        const score = matchScore(item.query, p.name, p.brand);
        if (score < 0.45) return;
        for (const [retailer, price, daysAgo] of p.prices) {
          if (req.retailer && !retailer.toLowerCase().includes(req.retailer.toLowerCase())) continue;
          const observed = new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);
          mine.push({
            offerId: `sandbox:${pi}:${retailer.toLowerCase().replace(/[^a-z]+/g, "-")}`,
            query: item.query,
            quantity: item.quantity,
            rank: 0,
            productName: p.name,
            brand: p.brand || null,
            size: p.size,
            gtin: null,
            price,
            currency: "USD",
            pricePer: p.size === "per lb" ? "pound" : "unit",
            regularPrice: null,
            isDiscounted: false,
            availability: daysAgo <= 45 ? "recently_seen" : "previously_seen",
            priceObservedAt: observed,
            retailer,
            storeLocation: null,
            source: "sandbox",
            // A real public search page for the item. It is not where the fixture price came from.
            sourceUrl: `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(item.query)}`,
            productUrl: null,
            imageUrl: null,
            matchScore: score,
            retrievedAt: now.toISOString(),
          });
        }
      });
      offers.push(
        ...mine
          .sort(compareOffers)
          .slice(0, req.maxResultsPerItem ?? 5)
          .map((o, i) => ({ ...o, rank: i + 1 })),
      );
    }
    return {
      backend: "sandbox",
      items: rebuild(items, offers),
      offers,
      run: null,
      warnings: ["Sandbox fixture catalog: prices are illustrative, not live."],
      generatedAt: now.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Selection + graceful fallback
// ---------------------------------------------------------------------------

function has(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

/** Which backend the current environment selects (see .env.example). */
export function selectedDiscoveryBackend(): DiscoveryBackend {
  const forced = process.env.GROCERY_DISCOVERY_MODE?.trim().toLowerCase();
  if (forced === "sandbox" || forced === "local") return forced;
  if (has("APIFY_TOKEN") && has("APIFY_GROCERY_ACTOR_ID")) return "apify";
  return "local";
}

/**
 * Wraps a preferred provider with fallbacks so Care always gets an answer, and
 * the result says exactly which backend produced it.
 */
class FallbackDiscovery implements GroceryDiscoveryProvider {
  constructor(private readonly chain: GroceryDiscoveryProvider[]) {}
  get backend(): DiscoveryBackend {
    return this.chain[0].backend;
  }
  async discover(req: DiscoveryRequest): Promise<GroceryDiscovery> {
    const failures: string[] = [];
    for (const provider of this.chain) {
      try {
        const result = await provider.discover(req);
        if (!failures.length) return result;
        return { ...result, fallbackFrom: this.chain[0].backend, warnings: [...failures, ...result.warnings] };
      } catch (err) {
        failures.push(`${provider.backend} discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(failures.join("; "));
  }
}

const GLOBAL_KEY = "__sahaya_grocery_discovery__";

export function getGroceryDiscoveryProvider(): GroceryDiscoveryProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as GroceryDiscoveryProvider;
  const mode = selectedDiscoveryBackend();
  const sandbox = new SandboxGroceryDiscovery();
  const provider =
    mode === "apify"
      ? new FallbackDiscovery([
          new ApifyGroceryDiscovery(process.env.APIFY_TOKEN!.trim(), process.env.APIFY_GROCERY_ACTOR_ID!.trim()),
          new LocalGroceryDiscovery(),
          sandbox,
        ])
      : mode === "local"
        ? new FallbackDiscovery([new LocalGroceryDiscovery(), sandbox])
        : sandbox;
  g[GLOBAL_KEY] = provider;
  return provider;
}

export function setGroceryDiscoveryProvider(p: GroceryDiscoveryProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}

export function resetGroceryDiscoveryProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
