/**
 * Normalized data contract for the Grocery Product Discovery Actor.
 *
 * Every source (Open Prices, Kroger, ...) maps its raw payload into ProductOffer,
 * so consumers (Sahaya's Care agent, or anyone running the Actor) get one
 * stable shape regardless of where the data came from.
 */

/** "sandbox" is reserved for consumers' offline fixtures; the Actor itself never emits it. */
export type SourceId = "open-prices" | "kroger" | "sandbox";

/**
 * Availability indicator. Live inventory sources (Kroger) report stock levels;
 * crowd-sourced price observations (Open Prices) can only say when the product
 * was last seen on a shelf, so they use the "seen" values instead of claiming stock.
 */
export type Availability =
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "recently_seen"
  | "previously_seen"
  | "unknown";

export type PricePer = "unit" | "kilogram" | "liter" | "pound";

export interface ShoppingItem {
  /** Cleaned search text, e.g. "whole milk". */
  query: string;
  /** Requested quantity parsed from the list entry ("2 x eggs" -> 2). */
  quantity: number;
  /** The entry as the user wrote it. */
  raw: string;
}

export interface ProductOffer {
  /** Stable id for this offer: source + product + store. */
  offerId: string;
  query: string;
  quantity: number;
  /** 1-based rank within this query's results. */
  rank: number;
  productName: string;
  brand: string | null;
  size: string | null;
  /** Barcode (GTIN/UPC/EAN) when known. */
  gtin: string | null;
  price: number | null;
  currency: string | null;
  /** What the price is quoted per. null when unknown. */
  pricePer: PricePer | null;
  regularPrice: number | null;
  isDiscounted: boolean;
  availability: Availability;
  /** ISO date the price was observed / reported by the source. */
  priceObservedAt: string | null;
  retailer: string | null;
  storeLocation: string | null;
  source: SourceId;
  /** Public page backing this record (price observation or retailer product page). */
  sourceUrl: string;
  /** Public product page, when different from sourceUrl. */
  productUrl: string | null;
  imageUrl: string | null;
  /** 0..1 relevance of productName to the query. */
  matchScore: number;
  retrievedAt: string;
}

export type ItemStatus = "priced" | "unpriced" | "not_found" | "error";

export interface ItemSummary {
  query: string;
  quantity: number;
  raw: string;
  status: ItemStatus;
  offersFound: number;
  /** Highest-ranked priced offer, or highest-ranked offer when none are priced. */
  topOffer: ProductOffer | null;
  /** Cheapest priced offer among strong matches. */
  cheapestOffer: ProductOffer | null;
  priceRange: { min: number; max: number; currency: string } | null;
  error?: string;
}

export interface KrogerCredentials {
  clientId: string;
  clientSecret: string;
  locationId?: string;
}

export interface DiscoveryInput {
  shoppingList: string[];
  sources?: SourceId[];
  maxResultsPerItem?: number;
  /** ISO country code; drives product search scope and the default currency. */
  country?: string;
  currency?: string;
  /** Ignore price observations older than this. */
  maxPriceAgeDays?: number;
  /** Only keep stores whose name contains this text (e.g. "Walmart"). */
  retailer?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  /** Also return matching products with no known price. */
  includeUnpriced?: boolean;
  kroger?: KrogerCredentials;
}

export interface DiscoveryResult {
  offers: ProductOffer[];
  items: ItemSummary[];
  stats: {
    itemsRequested: number;
    itemsPriced: number;
    offersReturned: number;
    sources: SourceId[];
    durationMs: number;
  };
  warnings: string[];
  generatedAt: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DiscoveryDeps {
  fetch?: FetchLike;
  now?: () => Date;
  log?: (msg: string) => void;
}
