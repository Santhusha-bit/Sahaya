import { mapLimit } from "./http";
import { parseShoppingList } from "./parse";
import { COUNTRIES, searchOpenPrices } from "./sources/openPrices";
import { searchKroger } from "./sources/kroger";
import type {
  Availability,
  DiscoveryDeps,
  DiscoveryInput,
  DiscoveryResult,
  ItemSummary,
  ProductOffer,
  ShoppingItem,
  SourceId,
} from "./types";

export * from "./types";
export { parseShoppingList, parseEntry, cleanQuery } from "./parse";
export { matchScore, tokens } from "./match";

/** Offers this close to the best match score count as "strong" when picking the cheapest. */
const STRONG_MATCH_BAND = 0.15;

const AVAILABILITY_ORDER: Record<Availability, number> = {
  in_stock: 0,
  low_stock: 1,
  recently_seen: 2,
  previously_seen: 3,
  unknown: 4,
  out_of_stock: 5,
};

/** At or above this score a product is a strong match for the query. */
const STRONG_MATCH = 0.65;

/**
 * Sort: strong matches first, then priced before unpriced, then relevance (in
 * 0.1 buckets), availability, recency, price. Pricing outranks a slightly better
 * name match because a price is what the shopping list needs.
 */
export function compareOffers(a: ProductOffer, b: ProductOffer): number {
  const strong = (o: ProductOffer) => Number(o.matchScore >= STRONG_MATCH);
  const bucket = (o: ProductOffer) => Math.round(o.matchScore * 10);
  return (
    strong(b) - strong(a) ||
    Number(b.price != null) - Number(a.price != null) ||
    bucket(b) - bucket(a) ||
    AVAILABILITY_ORDER[a.availability] - AVAILABILITY_ORDER[b.availability] ||
    (b.priceObservedAt ?? "").localeCompare(a.priceObservedAt ?? "") ||
    (a.price ?? Infinity) - (b.price ?? Infinity)
  );
}

export function summarizeItem(item: ShoppingItem, offers: ProductOffer[], error?: string): ItemSummary {
  const priced = offers.filter((o) => o.price != null && o.availability !== "out_of_stock");
  const best = offers.length ? Math.max(...offers.map((o) => o.matchScore)) : 0;
  const strong = priced.filter((o) => o.matchScore >= best - STRONG_MATCH_BAND);
  const cheapest = [...strong].sort((a, b) => a.price! - b.price! || compareOffers(a, b))[0] ?? null;
  const prices = priced.map((o) => o.price!);
  const status = error && !offers.length ? "error" : priced.length ? "priced" : offers.length ? "unpriced" : "not_found";
  return {
    query: item.query,
    quantity: item.quantity,
    raw: item.raw,
    status,
    offersFound: offers.length,
    topOffer: priced[0] ?? offers[0] ?? null,
    cheapestOffer: cheapest,
    priceRange: prices.length ? { min: Math.min(...prices), max: Math.max(...prices), currency: priced[0].currency ?? "" } : null,
    ...(error ? { error } : {}),
  };
}

/** Normalize and bound the raw input, applying documented defaults. */
export function resolveInput(input: DiscoveryInput) {
  const country = (input.country ?? "us").toLowerCase();
  const sources: SourceId[] = (input.sources?.length ? input.sources : ["open-prices"]).filter(
    (s): s is SourceId => s === "open-prices" || s === "kroger",
  );
  return {
    items: parseShoppingList(input.shoppingList),
    sources: [...new Set(sources)],
    maxResultsPerItem: Math.min(25, Math.max(1, Math.floor(input.maxResultsPerItem ?? 5))),
    country,
    currency: (input.currency ?? COUNTRIES[country]?.currency ?? "USD").toUpperCase(),
    maxPriceAgeDays: Math.min(3650, Math.max(1, Math.floor(input.maxPriceAgeDays ?? 365))),
    retailer: input.retailer?.trim() || undefined,
    latitude: input.latitude,
    longitude: input.longitude,
    radiusKm: input.radiusKm,
    includeUnpriced: input.includeUnpriced ?? true,
    kroger: input.kroger?.clientId && input.kroger.clientSecret ? input.kroger : undefined,
  };
}

/**
 * Run product discovery for a whole shopping list. Pure apart from the injected
 * fetch, so the same code runs inside the Apify Actor, in Sahaya's local mode,
 * and in tests with a mocked fetch.
 */
export async function discoverProducts(input: DiscoveryInput, deps: DiscoveryDeps = {}): Promise<DiscoveryResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const cfg = resolveInput(input);
  const warnings: string[] = [];

  if (!cfg.items.length) {
    return {
      offers: [],
      items: [],
      stats: { itemsRequested: 0, itemsPriced: 0, offersReturned: 0, sources: cfg.sources, durationMs: 0 },
      warnings: ["Shopping list is empty; nothing to search."],
      generatedAt: now.toISOString(),
    };
  }
  if (cfg.sources.includes("kroger") && !cfg.kroger) {
    warnings.push("Kroger source skipped: krogerClientId and krogerClientSecret are required.");
  }

  const perItem = await mapLimit(cfg.items, 2, async (item) => {
    const found: ProductOffer[] = [];
    const errors: string[] = [];
    if (cfg.sources.includes("open-prices")) {
      try {
        const r = await searchOpenPrices(fetchImpl, item, { ...cfg, now });
        found.push(...r.offers);
        warnings.push(...r.warnings.map((w) => `${item.query}: ${w}`));
      } catch (err) {
        errors.push(`open-prices: ${(err as Error).message}`);
      }
    }
    if (cfg.sources.includes("kroger") && cfg.kroger) {
      try {
        found.push(...(await searchKroger(fetchImpl, item, cfg.kroger, now)));
      } catch (err) {
        errors.push(`kroger: ${(err as Error).message}`);
      }
    }
    const unique = [...new Map(found.map((o) => [o.offerId, o])).values()];
    const ranked = unique
      .filter((o) => o.matchScore > 0)
      .sort(compareOffers)
      .slice(0, cfg.maxResultsPerItem)
      .map((o, i) => ({ ...o, rank: i + 1 }));
    const error = errors.length ? errors.join("; ") : undefined;
    if (error) warnings.push(`${item.query}: ${error}`);
    log(`${item.query}: ${ranked.length} offer(s)${error ? ` (${error})` : ""}`);
    return { offers: ranked, summary: summarizeItem(item, ranked, error) };
  });

  const offers = perItem.flatMap((r) => r.offers);
  const items = perItem.map((r) => r.summary);
  return {
    offers,
    items,
    stats: {
      itemsRequested: cfg.items.length,
      itemsPriced: items.filter((i) => i.status === "priced").length,
      offersReturned: offers.length,
      sources: cfg.sources,
      durationMs: Date.now() - started,
    },
    warnings,
    generatedAt: now.toISOString(),
  };
}
