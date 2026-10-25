# Grocery Product Discovery: Shopping List to Prices

Give this Actor a plain shopping list such as `["whole milk", "2 x eggs", "bananas"]`. It returns **normalized grocery product offers**: product name, brand, size, price, currency, an availability indicator, the retailer and store, and a **source URL** for every record. It also returns a per-item summary with the cheapest strong match and the price range.

It works for meal-planning apps, price comparison, budgeting tools, and AI agents that shop for people. It was built for [Kinline](https://github.com/Santhusha-bit/Sahaya), an elder-care assistant whose Care agent uses it to prepare a grocery cart for the user to review and approve.

## Why this Actor

- **One stable schema across sources.** Every source maps into the same `ProductOffer` shape, so your code never parses retailer-specific payloads.
- **Permitted data only.** It does not scrape retailer websites or bypass terms of service. Sources are open-data projects whose licences allow reuse, plus official retailer APIs used with your own credentials.
- **Honest availability.** Live inventory sources report stock levels. Crowd-sourced price observations only say *when* a product was last seen on a shelf, and the Actor labels them that way instead of claiming the item is in stock.
- **List-friendly input.** It parses quantities (`2 x eggs`, `eggs x2`, `2 eggs`), splits comma-separated entries, and merges duplicates.
- **Ranked for shopping.** Strong name matches come first, priced offers before unpriced ones, then fresher and cheaper prices.

## Sources

| Source | Credentials | What you get |
| --- | --- | --- |
| `open-prices` (default) | None | Product data from [Open Food Facts](https://world.openfoodfacts.org) plus real shelf and receipt prices reported at named stores (Walmart, Safeway, Costco, Whole Foods, ...) by [Open Prices](https://prices.openfoodfacts.org). Both are ODbL open data. Raw produce without barcodes (bananas, apples) is priced by category. |
| `kroger` (optional) | Your [Kroger developer](https://developer.kroger.com) client ID and secret | Kroger's official Products API: current regular and promo prices and stock level (`in_stock` / `low_stock` / `out_of_stock`) for a store `krogerLocationId`. |

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `shoppingList` | string[] | required | One item per entry, optional quantity. Up to 50 distinct items. |
| `sources` | string[] | `["open-prices"]` | `open-prices` and/or `kroger`. |
| `maxResultsPerItem` | integer | 5 | Ranked offers returned per list item (1 to 25). |
| `country` | string | `us` | Scopes product search and sets the default currency. |
| `currency` | string | country default | Override, e.g. `USD`. |
| `maxPriceAgeDays` | integer | 365 | Ignore older price observations. |
| `retailer` | string | | Keep only stores whose name contains this text, e.g. `Walmart`. |
| `latitude`, `longitude`, `radiusKm` | number | | Keep only stores near a point. |
| `includeUnpriced` | boolean | true | Also return matching products with no recent price. |
| `krogerClientId`, `krogerClientSecret`, `krogerLocationId` | string | | Kroger source only. The secret is stored encrypted. |

```json
{
  "shoppingList": ["whole milk", "2 x eggs", "bananas", "whole wheat bread", "rolled oats"],
  "maxResultsPerItem": 3
}
```

## Output

### Dataset: one row per product offer

```json
{
  "offerId": "open-prices:0046567040295:4191",
  "query": "eggs",
  "quantity": 2,
  "rank": 1,
  "productName": "Eggs",
  "brand": "Raley's",
  "size": null,
  "gtin": "0046567040295",
  "price": 8.49,
  "currency": "USD",
  "pricePer": "unit",
  "regularPrice": 11.99,
  "isDiscounted": true,
  "availability": "previously_seen",
  "priceObservedAt": "2026-01-25",
  "retailer": "Nob Hill Foods",
  "storeLocation": "Mountain View, US",
  "source": "open-prices",
  "sourceUrl": "https://prices.openfoodfacts.org/prices/296820",
  "productUrl": "https://prices.openfoodfacts.org/products/0046567040295",
  "imageUrl": "https://images.openfoodfacts.org/images/products/004/656/704/0295/front_en.3.400.jpg",
  "matchScore": 1,
  "retrievedAt": "2026-10-25T05:10:01.411Z"
}
```

`availability` is one of:

- `in_stock`, `low_stock`, `out_of_stock`: live stock level (Kroger).
- `recently_seen`: the price was observed on a shelf in the last 45 days.
- `previously_seen`: the price was observed, but more than 45 days ago.
- `unknown`: no availability signal.

`pricePer` is `unit`, `kilogram`, `liter` or `pound`. Produce priced by weight is reported per kilogram or pound and is never silently converted.

### Key-value store `OUTPUT`: one summary per list item

```json
{
  "items": [
    {
      "query": "eggs",
      "quantity": 2,
      "status": "priced",
      "offersFound": 3,
      "topOffer": { "...": "highest-ranked priced offer" },
      "cheapestOffer": { "...": "cheapest offer among strong matches" },
      "priceRange": { "min": 4.29, "max": 6.64, "currency": "USD" }
    }
  ],
  "stats": { "itemsRequested": 5, "itemsPriced": 5, "offersReturned": 15, "sources": ["open-prices"], "durationMs": 3400 },
  "warnings": []
}
```

`status` is `priced`, `unpriced` (products found, no recent price), `not_found` or `error`. One failing item never fails the whole run: its error is recorded on that item and in `warnings`.

## Use it from code

```bash
curl -X POST "https://api.apify.com/v2/acts/<username>~grocery-product-discovery/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"shoppingList": ["whole milk", "eggs"], "maxResultsPerItem": 3}'
```

```js
import { ApifyClient } from "apify-client";
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
const run = await client.actor("<username>/grocery-product-discovery").call({ shoppingList: ["whole milk", "eggs"] });
const { items } = await client.dataset(run.defaultDatasetId).listItems();
const summary = await client.keyValueStore(run.defaultKeyValueStoreId).getRecord("OUTPUT");
```

## Limits and responsible use

- Open Prices coverage is crowd-sourced. Popular items in large US cities are well covered; niche items may come back `unpriced`. Use `includeUnpriced` to still get the matching products.
- Prices are observations, not quotes. Always show `priceObservedAt` and `sourceUrl` to your users.
- Requests are polite: two list items in parallel, a descriptive User-Agent, and backoff on HTTP 429/5xx.
- Data from Open Food Facts and Open Prices is available under the Open Database License. Credit them when you redistribute it.

## Run locally

```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"shoppingList":["whole milk","2 x eggs"]}' > storage/key_value_stores/default/INPUT.json
npx tsx src/main.ts
```
