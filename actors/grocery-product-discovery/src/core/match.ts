/**
 * Query-to-product relevance scoring. Deliberately simple and deterministic:
 * the share of query words found in the product name, discounted when the name
 * is much longer than the query (so "Chocolate Banana Granola Bars" ranks below
 * "Bananas" for the query "bananas") and when the name's head noun is not a
 * query word.
 */

const STOP = new Set(["a", "an", "the", "of", "and", "with", "for", "in", "my", "usual", "some", "fresh", "pack", "box"]);

/** Size/unit words (already singularized) that can trail a product name. */
const UNITS = new Set(["gal", "gallon", "oz", "fl", "lb", "lbs", "ct", "count", "kg", "g", "ml", "l", "liter", "litre", "dozen", "pk", "qt", "pt"]);

/** Crude English singularization, enough to equate "eggs"/"egg", "berries"/"berry". */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|xes|sses|oes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(singular);
}

export function matchScore(query: string, productName: string, brand?: string | null): number {
  const q = [...new Set(tokens(query))];
  if (!q.length) return 0;
  const name = tokens(productName);
  const hay = new Set([...name, ...tokens(brand ?? "")]);
  const covered = q.filter((t) => hay.has(t)).length;
  if (!covered) return 0;
  const coverage = covered / q.length;
  const nameWords = Math.max(1, new Set(name).size);
  const focus = Math.min(1, q.length / nameWords);
  // English product names end in the head noun: "Part Skim Milk Cheese" is a
  // cheese, not milk. Names whose head is not a query word are discounted.
  const head = [...name].reverse().find((t) => /[a-z]/.test(t) && !UNITS.has(t) && !/^\d/.test(t));
  const headFactor = head && q.includes(head) ? 1 : 0.7;
  return Number((coverage * (0.6 + 0.4 * focus) * headFactor).toFixed(3));
}

/** Turn an Open Food Facts taxonomy tag ("en:whole-milks") into a label ("Whole milks"). */
export function humanizeTag(tag: string): string {
  const label = tag.replace(/^[a-z]{2}:/, "").replace(/-/g, " ").trim();
  return label ? label[0].toUpperCase() + label.slice(1) : tag;
}

/** Candidate category tags for raw products priced by category ("bananas" -> "en:bananas"). */
export function categoryTagsFor(query: string): string[] {
  const words = tokens(query);
  if (!words.length || words.length > 3) return [];
  const slug = words.join("-");
  const plural = slug.endsWith("y") ? `${slug.slice(0, -1)}ies` : slug.endsWith("s") ? slug : `${slug}s`;
  return [...new Set([`en:${plural}`, `en:${slug}`])];
}
