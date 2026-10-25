import { Actor, log } from "apify";
import { discoverProducts, type DiscoveryInput, type SourceId } from "./core/discover";

interface ActorInput {
  shoppingList?: string[] | string;
  sources?: SourceId[];
  maxResultsPerItem?: number;
  country?: string;
  currency?: string;
  maxPriceAgeDays?: number;
  retailer?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  includeUnpriced?: boolean;
  krogerClientId?: string;
  krogerClientSecret?: string;
  krogerLocationId?: string;
}

await Actor.init();

try {
  const input = (await Actor.getInput<ActorInput>()) ?? {};
  const shoppingList = Array.isArray(input.shoppingList)
    ? input.shoppingList
    : typeof input.shoppingList === "string"
      ? [input.shoppingList]
      : [];
  if (!shoppingList.length) {
    await Actor.fail("Input `shoppingList` is required: an array of grocery items, e.g. [\"whole milk\", \"2 x eggs\"].");
  }

  const discoveryInput: DiscoveryInput = {
    shoppingList,
    sources: input.sources,
    maxResultsPerItem: input.maxResultsPerItem,
    country: input.country,
    currency: input.currency || undefined,
    maxPriceAgeDays: input.maxPriceAgeDays,
    retailer: input.retailer,
    latitude: input.latitude,
    longitude: input.longitude,
    radiusKm: input.radiusKm,
    includeUnpriced: input.includeUnpriced,
    kroger:
      input.krogerClientId && input.krogerClientSecret
        ? { clientId: input.krogerClientId, clientSecret: input.krogerClientSecret, locationId: input.krogerLocationId }
        : undefined,
  };

  await Actor.setStatusMessage(`Searching ${shoppingList.length} shopping list entr${shoppingList.length === 1 ? "y" : "ies"}...`);
  const result = await discoverProducts(discoveryInput, { log: (m) => log.info(m) });

  // One dataset row per product offer: the normalized, table-friendly output.
  if (result.offers.length) await Actor.pushData(result.offers);

  // Per-item summary (cheapest strong match, price range, status) for consumers
  // that want "one answer per list item" without re-ranking the dataset.
  await Actor.setValue("OUTPUT", {
    items: result.items,
    stats: result.stats,
    warnings: result.warnings,
    generatedAt: result.generatedAt,
  });

  for (const w of result.warnings) log.warning(w);
  const { itemsRequested, itemsPriced, offersReturned } = result.stats;
  await Actor.setStatusMessage(
    `Done: ${offersReturned} product offer(s); ${itemsPriced}/${itemsRequested} list item(s) priced.`,
    { isStatusMessageTerminal: true },
  );
  await Actor.exit();
} catch (err) {
  log.exception(err as Error, "Grocery product discovery failed");
  await Actor.fail(`Grocery product discovery failed: ${(err as Error).message}`);
}
