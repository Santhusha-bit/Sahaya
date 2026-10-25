/**
 * Kroger source (optional). Uses Kroger's official public Products API
 * (developer.kroger.com) with the caller's own client credentials, so access is
 * explicitly permitted. Prices and stock levels require a store locationId.
 */

import { fetchJson } from "../http";
import { matchScore } from "../match";
import type { Availability, FetchLike, KrogerCredentials, ProductOffer, ShoppingItem } from "../types";

const API = "https://api.kroger.com/v1";
const WEB = "https://www.kroger.com";

interface KrogerProduct {
  productId?: string;
  upc?: string;
  brand?: string;
  description?: string;
  productPageURI?: string;
  images?: { perspective?: string; featured?: boolean; sizes?: { size?: string; url?: string }[] }[];
  items?: {
    size?: string;
    soldBy?: string;
    price?: { regular?: number; promo?: number };
    inventory?: { stockLevel?: "HIGH" | "LOW" | "TEMPORARILY_OUT_OF_STOCK" };
    fulfillment?: { inStore?: boolean; delivery?: boolean; curbside?: boolean };
  }[];
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(fetchImpl: FetchLike, creds: KrogerCredentials): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
  const res = await fetchJson<{ access_token?: string; expires_in?: number }>(fetchImpl, {
    url: `${API}/connect/oauth2/token`,
    init: {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=product.compact",
    },
    retries: 1,
  });
  if (!res.access_token) throw new Error("Kroger token response had no access_token");
  tokenCache.set(creds.clientId, { token: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 1800) * 1000 });
  return res.access_token;
}

function availability(item: NonNullable<KrogerProduct["items"]>[number] | undefined): Availability {
  switch (item?.inventory?.stockLevel) {
    case "HIGH":
      return "in_stock";
    case "LOW":
      return "low_stock";
    case "TEMPORARILY_OUT_OF_STOCK":
      return "out_of_stock";
    default:
      return item?.fulfillment?.inStore || item?.fulfillment?.delivery ? "in_stock" : "unknown";
  }
}

function imageUrl(p: KrogerProduct): string | null {
  const img = p.images?.find((i) => i.featured) ?? p.images?.[0];
  const size = img?.sizes?.find((s) => s.size === "medium") ?? img?.sizes?.[0];
  return size?.url ?? null;
}

export async function searchKroger(
  fetchImpl: FetchLike,
  item: ShoppingItem,
  creds: KrogerCredentials,
  now: Date,
): Promise<ProductOffer[]> {
  const token = await accessToken(fetchImpl, creds);
  const params = new URLSearchParams({ "filter.term": item.query, "filter.limit": "15" });
  if (creds.locationId) params.set("filter.locationId", creds.locationId);
  const res = await fetchJson<{ data?: KrogerProduct[] }>(fetchImpl, {
    url: `${API}/products?${params}`,
    init: { headers: { Authorization: `Bearer ${token}` } },
  });
  const nowIso = now.toISOString();
  const offers: ProductOffer[] = [];
  for (const p of res.data ?? []) {
    if (!p.productId || !p.description) continue;
    const first = p.items?.[0];
    const promo = first?.price?.promo;
    const regular = first?.price?.regular;
    const price = typeof promo === "number" && promo > 0 ? promo : typeof regular === "number" && regular > 0 ? regular : null;
    const page = p.productPageURI ? `${WEB}${p.productPageURI.startsWith("/") ? "" : "/"}${p.productPageURI}` : `${WEB}/p/item/${p.productId}`;
    offers.push({
      offerId: `kroger:${p.productId}:${creds.locationId ?? "x"}`,
      query: item.query,
      quantity: item.quantity,
      rank: 0,
      productName: p.description.trim(),
      brand: p.brand?.trim() || null,
      size: first?.size?.trim() || null,
      gtin: p.upc ?? null,
      price,
      currency: price != null ? "USD" : null,
      pricePer: first?.soldBy?.toUpperCase() === "WEIGHT" ? "pound" : price != null ? "unit" : null,
      regularPrice: typeof regular === "number" ? regular : null,
      isDiscounted: typeof promo === "number" && promo > 0 && typeof regular === "number" && promo < regular,
      availability: creds.locationId ? availability(first) : "unknown",
      priceObservedAt: price != null ? nowIso.slice(0, 10) : null,
      retailer: "Kroger",
      storeLocation: creds.locationId ? `Kroger store ${creds.locationId}` : null,
      source: "kroger",
      sourceUrl: page,
      productUrl: page,
      imageUrl: imageUrl(p),
      matchScore: matchScore(item.query, p.description, p.brand),
      retrievedAt: nowIso,
    });
  }
  return offers;
}
