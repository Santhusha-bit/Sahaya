/**
 * Deterministic interpretation of short user replies. These gates decide safety-relevant facts
 * (did the user explicitly say they took a dose? did they say yes?), so they are plain code with
 * conservative defaults: hedged or ambiguous answers are never treated as confirmation.
 * Claude may phrase questions and explain results, but these functions make the call.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function clauses(text: string): string[] {
  return normalize(text)
    .split(/[.!?;,]|\bbut\b|\bthough\b/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const UNSURE = [
  /\bnot sure\b/,
  /\bunsure\b/,
  /\b(don't|do not|can't|cannot|can not) remember\b/,
  /\bi think\b/,
  /\bmaybe\b/,
  /\bmight have\b/,
  /\bprobably\b/,
  /\bi guess\b/,
  /\bperhaps\b/,
];
const NEGATIVE = [
  /\bforgot\b/,
  /\bhaven't\b/,
  /\bhave not\b/,
  /\bdidn't\b/,
  /\bdid not\b/,
  /\bnot yet\b/,
  /^no\b/,
  /\bnope\b/,
  /\bnot taken\b/,
  /\bgoing to take\b/,
  /\bwill take\b/,
  /\btaking it now\b/,
  /\babout to take\b/,
  /\bgonna take\b/,
];
const POSITIVE = [
  /\bi took\b/,
  /\bi've taken\b/,
  /\bi have taken\b/,
  /\bi just took\b/,
  /\btook (it|them|my|the)\b/,
  /\btaken (it|them|my|the)\b/,
  /\bi've had (it|them|my)\b/,
];
const AFFIRMATIVE = /^(yes|yep|yeah|yup|i have|i did|done|correct|that's right|that is right)\b/;

export type DoseReply = "taken" | "not_taken" | "unsure" | "no_answer";

/**
 * Classify a reply to "Have you taken your medication?". `taken` only for an explicit statement
 * that the dose was taken (or a plain yes to that exact question). Hedging anywhere → `unsure`.
 * Mixed replies use the last clause ("I forgot, but I've taken it now" → taken).
 */
export function classifyDoseReply(text: string | null | undefined): DoseReply {
  if (!text || !normalize(text)) return "no_answer";
  const all = normalize(text);
  if (UNSURE.some((r) => r.test(all))) return "unsure";
  let verdict: DoseReply = "unsure";
  let decided = false;
  for (const c of clauses(text)) {
    if (NEGATIVE.some((r) => r.test(c))) {
      verdict = "not_taken";
      decided = true;
    } else if (POSITIVE.some((r) => r.test(c)) || AFFIRMATIVE.test(c)) {
      verdict = "taken";
      decided = true;
    }
  }
  return decided ? verdict : "unsure";
}

export type YesNo = "yes" | "no" | "unclear";

export function classifyYesNo(text: string | null | undefined): YesNo {
  if (!text) return "unclear";
  const t = normalize(text);
  if (UNSURE.some((r) => r.test(t))) return "unclear";
  if (/^(no|nope|nah|not really|that's wrong|that is wrong|wrong)\b/.test(t)) return "no";
  if (/^(yes|yep|yeah|yup|correct|that's right|that is right|right|sure|ok|okay|please do|go ahead)\b/.test(t)) return "yes";
  return "unclear";
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30,
};

/** "I only have two pills left" → 2. Returns null when no single count is stated. */
export function extractPillCount(text: string): number | null {
  const t = normalize(text);
  const found: number[] = [];
  for (const m of t.matchAll(/\b(\d{1,4})\b/g)) found.push(Number(m[1]));
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) found.push(n);
  const unique = [...new Set(found)];
  return unique.length === 1 ? unique[0] : null;
}

export type CookingCommand = "next" | "repeat" | "slower" | "simpler" | "back" | "stop";

export function parseCookingCommand(text: string): CookingCommand | null {
  const t = normalize(text);
  if (/\b(next|continue|go on|what's next|done with that)\b/.test(t)) return "next";
  if (/\b(repeat|again|say that again|what was that|pardon)\b/.test(t)) return "repeat";
  if (/\b(slower|slow down|too fast)\b/.test(t)) return "slower";
  if (/\b(simpler|simplify|easier|confusing|plain)\b/.test(t)) return "simpler";
  if (/\b(back|previous|go back)\b/.test(t)) return "back";
  if (/\b(stop|quit|finish|end)\b/.test(t)) return "stop";
  return null;
}

export function detectCookingDifficulty(text: string): boolean {
  const t = normalize(text);
  return [
    /cook\w* (is|has been) (getting|becoming) (hard|difficult|harder|too much)/,
    /(hard|difficult|harder|tiring) (for me )?to cook/,
    /(can't|cannot|struggl\w* to) cook/,
    /too tired to cook/,
    /cooking is (hard|difficult|too much)/,
    /trouble (cooking|making meals)/,
  ].some((r) => r.test(t));
}

export type MedicationConcern = "possible_overdose" | "possible_wrong_dose" | "symptoms";

/**
 * Detect statements that need a safety response instead of routine handling. Conservative: when in
 * doubt it flags, because the response (call a pharmacist / doctor / emergency services) is safe.
 */
export function detectMedicationConcern(text: string): { kind: MedicationConcern; urgent: boolean } | null {
  const t = normalize(text);
  const urgentSymptoms = /(chest pain|can't breathe|cannot breathe|trouble breathing|fainted|passed out|unconscious|seizure|very dizzy|confused|swelling of (my )?(face|throat|lips))/;
  if (/(took|taken|swallowed) (too many|extra|a lot|the whole|double|twice)|overdose|took (two|2|three|3) doses|took it twice|double dose/.test(t)) {
    return { kind: "possible_overdose", urgent: true };
  }
  if (/(wrong (pill|medication|medicine|dose|tablet))|(took (my|the) (evening|night|morning) (pill|medication|dose) (instead|by mistake))|someone else's (pill|medication)/.test(t)) {
    return { kind: "possible_wrong_dose", urgent: urgentSymptoms.test(t) };
  }
  if (urgentSymptoms.test(t)) return { kind: "symptoms", urgent: true };
  if (/(dizzy|nause|sick|rash|headache|feel (strange|weird|unwell|off)|side effect)/.test(t)) {
    return { kind: "symptoms", urgent: false };
  }
  return null;
}

export interface GroceryIntent {
  usual: boolean;
  runningLow: boolean;
  items: string[];
}

/**
 * Deterministic fallback for the three common request shapes. Claude normally produces the
 * structured tool call; this keeps demos and keyless operation working and is never used to
 * bypass safety checks (items still go through the catalog and allergy filter).
 */
export function interpretGroceryRequest(text: string): GroceryIntent {
  const t = normalize(text);
  const runningLow = /(running (out|low)|low on|nearly out|out of) (of )?(groceries|food|everything)/.test(t);
  const usual = runningLow || /(usual|usually|regular|same as (last time|always)|normal order)/.test(t);
  const items: string[] = [];
  const need = /(?:i need|get me|pick up|buy|i'd like|add)\s+(?:some\s+)?(.+)/.exec(t);
  if (need && !/what i usually buy/.test(need[1])) {
    for (const part of need[1].split(/,|\band\b|&/)) {
      const item = part.replace(/\b(some|a|an|more|please|too|also)\b/g, "").replace(/[^a-z\s-]/g, "").trim();
      if (item && item.length <= 40) items.push(item);
    }
  }
  return { usual, runningLow, items };
}
