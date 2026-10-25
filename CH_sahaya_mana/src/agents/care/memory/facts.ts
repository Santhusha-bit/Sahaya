/**
 * Care's learned memory about one person: small structured facts with provenance and a status.
 * Pure functions only — the service (services/memoryService.ts) does storage and permission checks.
 *
 * Status ladder (never skipped by code that guesses):
 *   inferred  – a tentative pattern from behaviour (e.g. bought oat milk in 2+ orders). Ask before relying on it.
 *               Never created for safety-critical kinds.
 *   reported  – the user said it (quoted from their own message), not yet confirmed back.
 *   confirmed – the user said yes when Care read it back (checked by the deterministic yes/no classifier),
 *               or the user entered/corrected it themselves on their dashboard.
 * Anything not stored is unknown, and Care says so instead of guessing.
 */
import { looksLikeInjection, sanitizeUntrusted } from "../domain/untrusted";

export const FACT_KINDS = [
  "name",
  "address_as",
  "reminder_preference",
  "grocery_preference",
  "brand_preference",
  "usual_item",
  "allergy",
  "dietary_restriction",
  "household_essential",
  "cooking_preference",
  "meal_habit",
  "accessibility",
  "caregiver",
  "other",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type FactStatus = "confirmed" | "reported" | "inferred";

/** Safety-critical facts: only the user (or the user's own dashboard edit) can confirm them; never inferred. */
export const SAFETY_CRITICAL: ReadonlySet<FactKind> = new Set(["allergy", "dietary_restriction", "caregiver"]);

export const KIND_LABEL: Record<FactKind, string> = {
  name: "Name",
  address_as: "How to address you",
  reminder_preference: "Reminder preference",
  grocery_preference: "Grocery preference",
  brand_preference: "Brand preference",
  usual_item: "Usual purchase",
  allergy: "Allergy",
  dietary_restriction: "Dietary restriction",
  household_essential: "Household essential",
  cooking_preference: "Cooking preference",
  meal_habit: "Meal habit",
  accessibility: "Accessibility",
  caregiver: "Caregiver",
  other: "Other",
};

export type FactArea = "profile" | "medications" | "grocery";
/** Which permission area a fact belongs to (caregivers see only areas they are granted). */
export const KIND_AREA: Record<FactKind, FactArea> = {
  name: "profile",
  address_as: "profile",
  reminder_preference: "medications",
  grocery_preference: "grocery",
  brand_preference: "grocery",
  usual_item: "grocery",
  allergy: "grocery",
  dietary_restriction: "grocery",
  household_essential: "grocery",
  cooking_preference: "grocery",
  meal_habit: "grocery",
  accessibility: "profile",
  caregiver: "profile",
  other: "profile",
};

export interface FactSource {
  by: string;
  role: "older_adult" | "caregiver" | "system";
  via: "conversation" | "dashboard" | "behavior" | "demo";
  /** Message id the fact was taken from (provenance without storing the transcript). */
  messageId?: string;
}

export interface FactHistoryEntry {
  at: number;
  change: "created" | "corrected" | "confirmed" | "observed_again";
  status: FactStatus;
  value: string;
  by: string;
}

export interface CareFact {
  id: string;
  kind: FactKind;
  /** Normalized subject, e.g. "milk", "peanut", "bread". One fact per kind+topic. */
  topic: string;
  /** Short plain-language value as the user put it, e.g. "oat milk", "Ellie". */
  value: string;
  status: FactStatus;
  safetyCritical: boolean;
  source: FactSource;
  /** Structured links this fact drives (validated by code): a catalog product, a filter tag, an allergen. */
  link?: { productId?: string; quantity?: number; tag?: string; allergen?: string; brand?: string };
  /** For inferred facts: how many times the pattern was observed. */
  evidence?: number;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  history: FactHistoryEntry[];
}

export function normalizeTopic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\b(my|the|a|an|some|usual|favourite|favorite)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<=[a-z]{3})s$/, "")
    .slice(0, 60);
}

/**
 * Facts are user content: sanitized, capped, and refused only if they read like instructions aimed at the agent
 * (the shared injection patterns) — ordinary words like "permission" or "admin" are fine.
 */
export function cleanFactValue(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const s = sanitizeUntrusted(raw, "memory", 160);
  if (!s.text) return { ok: false, reason: "empty value" };
  if (s.flagged || looksLikeInjection(raw)) {
    return { ok: false, reason: "that reads like an instruction, not a fact about the person, so it wasn't saved" };
  }
  return { ok: true, value: s.text };
}

// ── Evidence binding: the saved value must come from the person's own words ──────────

const STOP = new Set(
  ("i im i'm me my mine myself we our you your the a an to of and or but for with on in at from by is am are was were be been being " +
    "it its it's this that these those there here so very really just also too much many some any all usual usually always often normally " +
    "like likes liked love loves prefer prefers preferred want wants need needs use uses get gets buy buys bought have has had " +
    "eat eats eating drink drinks take takes call called name named please remember dear one ones kind sort thing things " +
    "allergic allergy allergies intolerant intolerance sensitive diet dietary restriction restrictions food foods item items")
    .split(/\s+/),
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function clausesOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[.!?;,]|\bbut\b|\binstead\b/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const NEGATOR = /\b(not|no|never|without|nope|don't|dont|doesn't|doesnt|isn't|isnt|aren't|arent|won't|wont|can't|cant|no longer|any ?more)\b|n't\b/;
const ALLERGY_NEGATED = /\b(not|never|no longer)\s+(\w+\s+){0,2}allergic\b|n't\s+(\w+\s+){0,2}allergic\b|\bno\s+(food\s+)?allerg/;
const HEDGE = /\b(i think|i guess|maybe|might|not sure|probably|perhaps|possibly|kind of)\b/;

export type Evidence =
  | { ok: true; hedged: boolean }
  | { ok: false; reason: "not_in_words" | "negated" | "ambiguous"; message: string };

/**
 * Deterministic check that a proposed fact is grounded in what the person actually said (their quoted words from
 * their latest message). Rejects values they didn't say, values they negated ("I'm not allergic to…", "I don't like X
 * anymore"), and asks for clarification when it can't tell. Hedged statements are accepted but flagged.
 */
export function verifyEvidence(kind: FactKind, value: string, statement: string, opts: { productWords?: string[]; affirmation?: boolean } = {}): Evidence {
  const said = words(statement);
  const saidSet = new Set(said);
  const productSet = new Set((opts.productWords ?? []).flatMap((w) => words(w)));
  const valueWords = words(value).filter((w) => !STOP.has(w));
  const clauses = clausesOf(statement);
  const clauseFor = (w: string) => clauses.find((c) => words(c).includes(w)) ?? "";

  if (kind === "name" || kind === "address_as") {
    const raw = words(value);
    if (!raw.length || !raw.every((w) => saidSet.has(w))) {
      return { ok: false, reason: "not_in_words", message: "Use the name exactly as the person said it, or ask them." };
    }
    return { ok: true, hedged: false };
  }
  if (!valueWords.length) {
    return { ok: false, reason: "ambiguous", message: "The value has no specific words to check. Ask the person to say it in their own words." };
  }

  if (kind === "allergy" || kind === "dietary_restriction") {
    const missing = valueWords.filter((w) => !saidSet.has(w));
    if (missing.length) {
      return { ok: false, reason: "not_in_words", message: "The person didn't say that. Save only the allergy or diet they named, in their words." };
    }
    const clause = clauseFor(valueWords[0]);
    if (kind === "allergy" && ALLERGY_NEGATED.test(clause)) {
      return { ok: false, reason: "negated", message: "The person said they are NOT allergic to that. Don't save it." };
    }
    return { ok: true, hedged: HEDGE.test(clause) };
  }

  const missing = valueWords.filter((w) => !saidSet.has(w) && !productSet.has(w));
  if (missing.length) {
    return { ok: false, reason: "not_in_words", message: "The person didn't say that. Save only what they said, or ask them." };
  }
  if (productSet.size) {
    const overlap = [...productSet].some((w) => !STOP.has(w) && saidSet.has(w));
    if (!overlap && !opts.affirmation) {
      return { ok: false, reason: "ambiguous", message: "It isn't clear which product they mean. Ask them to name it or say yes to it." };
    }
  }
  const relevant = valueWords.filter((w) => saidSet.has(w));
  if (relevant.some((w) => NEGATOR.test(clauseFor(w)))) {
    return { ok: false, reason: "negated", message: "The person said they don't want or like that. Ask what they prefer instead." };
  }
  return { ok: true, hedged: relevant.some((w) => HEDGE.test(clauseFor(w))) };
}

// ── Mapping to deterministic filters ────────────────────────────────────────

const ALLERGEN_WORDS: Array<[RegExp, string]> = [
  [/\bpeanut/, "peanut"],
  [/\b(tree ?nut|almond|cashew|walnut|pecan|hazelnut|pistachio)/, "tree_nut"],
  [/\b(milk|dairy|lactose)/, "milk"],
  [/\begg/, "egg"],
  [/\b(gluten|coeliac|celiac)/, "gluten"],
  [/\bwheat/, "wheat"],
  [/\b(soy|soya)/, "soy"],
  [/\b(shellfish|shrimp|prawn|crab|lobster)/, "shellfish"],
  [/\b(fish|salmon|tuna|cod)/, "fish"],
  [/\bsesame/, "sesame"],
];

/** Canonical allergen for the safety filter. Unknown allergens keep their own word (ingredient text is scanned). */
export function allergenFor(value: string): string {
  const v = value.toLowerCase();
  for (const [re, code] of ALLERGEN_WORDS) if (re.test(v)) return code;
  return normalizeTopic(v).replace(/\s+/g, "_");
}

const DIET_TAGS: Array<[RegExp, string]> = [
  [/\bvegan\b/, "vegan"],
  [/\b(dairy[- ]free|no dairy)\b/, "dairy_free"],
];
const PREFERENCE_TAGS: Array<[RegExp, string]> = [
  [/\b(low[- ]?(sodium|salt)|less salt|no added salt)\b/, "low_sodium"],
  [/\bwhole ?grain|whole ?wheat\b/, "whole_grain"],
  [/\bhigh[- ]protein\b/, "high_protein"],
  [/\bvegan\b/, "vegan"],
  [/\bdairy[- ]free\b/, "dairy_free"],
];

/** A hard restriction the catalog can enforce (a required product tag), or null if it can't be enforced. */
export function dietTagFor(value: string): string | null {
  const v = value.toLowerCase();
  for (const [re, tag] of DIET_TAGS) if (re.test(v)) return tag;
  return null;
}
/** Restrictions that are really allergen exclusions (gluten-free → avoid gluten). */
export function dietAllergenFor(value: string): string | null {
  const v = value.toLowerCase();
  if (/\b(gluten[- ]free|coeliac|celiac|no gluten)\b/.test(v)) return "gluten";
  if (/\b(lactose|dairy)[- ]free|no (dairy|lactose)\b/.test(v)) return "milk";
  return null;
}
export function preferenceTagFor(value: string): string | null {
  const v = value.toLowerCase();
  for (const [re, tag] of PREFERENCE_TAGS) if (re.test(v)) return tag;
  return null;
}

// ── Topic detection for targeted retrieval ──────────────────────────────────

export type Topic = "groceries" | "meals" | "medication" | "caregivers" | "memory" | "profile";

const TOPIC_PATTERNS: Array<[Topic, RegExp]> = [
  ["groceries", /\b(grocer\w*|shop\w*|store|buy|bought|order|cart|milk|bread|eggs?|brand|cheaper|deliver\w*|out of|run(ning)? (low|out)|supermarket|essentials?|toilet paper|soap|allerg\w*)\b/],
  ["meals", /\b(dinner|lunch|breakfast|meal|cook|recipe|eat|food|hungry|make for|kitchen|pantry|fridge|snack|allerg\w*|intoleran\w*|vegan|vegetarian|gluten|diet)\b/],
  ["medication", /\b(medic|pill|tablet|dose|prescription|pharmac|refill|remind|reminder|took|taken|forgot|forgetting|blood pressure|vitamin)\b/],
  ["caregivers", /\b(daughter|son|wife|husband|caregiver|carer|nurse|neighbou?r|friend|family|grand(daughter|son|child))\b/],
  ["memory", /\b(remember|forget|forgot about me|what do you know|about me|my preferences|delete|correct that|that's wrong|not anymore|any ?more|changed my mind|instead)\b/],
  ["profile", /\b(my name|call me|i'm called|i am called|hearing|eyesight|large text|speak (slower|louder))\b/],
];

export function detectTopics(text: string): Topic[] {
  const t = text.toLowerCase();
  return TOPIC_PATTERNS.filter(([, re]) => re.test(t)).map(([topic]) => topic);
}

export const TOPIC_KINDS: Record<Topic, FactKind[]> = {
  groceries: ["grocery_preference", "brand_preference", "usual_item", "household_essential", "allergy", "dietary_restriction"],
  meals: ["cooking_preference", "meal_habit", "allergy", "dietary_restriction"],
  medication: ["reminder_preference"],
  caregivers: ["caregiver"],
  memory: [...FACT_KINDS],
  profile: ["name", "address_as", "accessibility"],
};

const ALWAYS: FactKind[] = ["name", "address_as", "accessibility"];
const STALE_MS = 120 * 24 * 60 * 60 * 1000;

/** Select only the facts relevant to these topics (plus how to address the person). */
export function selectFacts(facts: CareFact[], topics: Topic[], limit = 14): CareFact[] {
  const kinds = new Set<FactKind>([...ALWAYS, ...topics.flatMap((t) => TOPIC_KINDS[t])]);
  return facts
    .filter((f) => kinds.has(f.kind))
    .sort((a, b) => Number(b.safetyCritical) - Number(a.safetyCritical) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

function statusNote(f: CareFact, now: number): string {
  if (f.status === "inferred") return "inferred guess — ask before relying on it";
  const stale = now - (f.confirmedAt ?? f.updatedAt) > STALE_MS;
  if (f.status === "reported") return stale ? "user said it, not confirmed, saved a while ago — check it still applies" : "user said it, not yet confirmed";
  return stale ? "confirmed, but a while ago — check it still applies if it matters" : "confirmed";
}

/** Escape so stored values can never close or open a context tag. */
function inert(s: string) {
  return s.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

/** The memory part of the per-turn context: data, with status, and explicit unknowns for safety kinds. */
export function renderFacts(facts: CareFact[], topics: Topic[], now: number): string[] {
  const lines = facts.map((f) => `- ${KIND_LABEL[f.kind]}: "${inert(f.value)}" [${statusNote(f, now)}; id ${f.id}]`);
  const needsSafety = topics.some((t) => t === "groceries" || t === "meals");
  if (needsSafety && !facts.some((f) => f.kind === "allergy")) lines.push("- Allergies: none recorded (unknown — don't assume there are none)");
  if (!facts.some((f) => f.kind === "name" || f.kind === "address_as")) lines.push("- Name: not known yet");
  return lines;
}
