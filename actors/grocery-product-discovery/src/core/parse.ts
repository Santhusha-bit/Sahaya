import type { ShoppingItem } from "./types";

export const MAX_ITEMS = 50;
const MAX_QUERY_LENGTH = 80;
const MAX_QUANTITY = 99;

/** Strip control characters and search-syntax punctuation, collapse whitespace. */
export function cleanQuery(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Characters with meaning in Lucene-style search syntax or URLs.
    .replace(/["'`:\\/(){}\[\]<>^~*?!|&+=#%;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

/**
 * Parse one shopping-list entry. Supports "eggs", "2 eggs", "2 x eggs",
 * "eggs x2" and "eggs (2)". Returns null for entries with no searchable text.
 */
export function parseEntry(raw: string): ShoppingItem | null {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  let quantity = 1;

  const lead = text.match(/^(\d{1,3})\s*(?:x|×|\*)?\s+(.+)$/i);
  const trail = text.match(/^(.+?)\s*(?:x|×|\*)\s*(\d{1,3})$/i) ?? text.match(/^(.+?)\s*\((\d{1,3})\)$/);
  if (lead) {
    quantity = Number(lead[1]);
    text = lead[2];
  } else if (trail) {
    quantity = Number(trail[2]);
    text = trail[1];
  }

  const query = cleanQuery(text);
  if (!query || !/[a-z]/i.test(query)) return null;
  quantity = Math.min(MAX_QUANTITY, Math.max(1, Math.floor(quantity) || 1));
  return { query, quantity, raw: String(raw).trim().slice(0, 120) };
}

/**
 * Parse a whole list. Entries may also contain comma or newline separated items.
 * Duplicates (same query, case-insensitive) are merged by summing quantities.
 */
export function parseShoppingList(entries: unknown): ShoppingItem[] {
  const list = Array.isArray(entries) ? entries : typeof entries === "string" ? [entries] : [];
  const byKey = new Map<string, ShoppingItem>();
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    for (const part of entry.split(/[\n,;]+/)) {
      const item = parseEntry(part);
      if (!item) continue;
      const key = item.query.toLowerCase();
      const existing = byKey.get(key);
      if (existing) existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + item.quantity);
      else byKey.set(key, item);
      if (byKey.size >= MAX_ITEMS) break;
    }
    if (byKey.size >= MAX_ITEMS) break;
  }
  return [...byKey.values()];
}
