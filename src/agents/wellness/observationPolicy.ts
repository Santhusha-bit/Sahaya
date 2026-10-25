/**
 * Deterministic observation policy engine (Part 5, Track A, steps 6-8).
 *
 * This is the security boundary for structured extraction. An inference provider
 * (Bitdeer or the sandbox) PROPOSES candidate observations; this pure, I/O-free
 * engine decides which are trustworthy by checking, in code (never via a prompt):
 *
 *   1. schema    — the candidate matches the strict schema.
 *   2. medical   — it is not a diagnosis or medication instruction (Wellness is
 *                  non-diagnostic and never changes medications).
 *   3. evidence  — every numeric value appears in the source text, and every
 *                  description is supported by the source. Invented numbers and
 *                  unsupported claims are rejected, not stored.
 *   4. range     — quantitative values use a valid unit and a plausible range.
 *
 * Anything plausible but weakly grounded is marked needs_confirmation rather than
 * silently accepted. This is what defends red-team cases 10, 11, 12, 13, 16, 25.
 */

import {
  CandidateObservationSchema,
  InferenceOutputSchema,
  QUANTITATIVE_TYPES,
  VALUE_RANGES,
  type CandidateObservation,
  type ObservationType,
} from "./observationSchema";

export type ObservationVerdict = "accepted" | "needs_confirmation" | "rejected";
export type PolicyLayer = "schema" | "injection" | "medical" | "evidence" | "range" | "ok";

export interface CandidateDecision {
  candidate: Partial<CandidateObservation> & { type?: string };
  verdict: ObservationVerdict;
  reason: string;
  layer: PolicyLayer;
  /** The exact source fragment supporting this observation (empty if none). */
  evidence: string;
}

export interface PolicyResult {
  accepted: CandidateDecision[];
  needsConfirmation: CandidateDecision[];
  rejected: CandidateDecision[];
  decisions: CandidateDecision[];
}

/** Clinical diagnosis vocabulary Wellness must never assert as an observation. */
export const DIAGNOSIS_TERMS = [
  "diagnos", "disorder", "clinical depression", "major depression", "dementia",
  "alzheimer", "syndrome", "hypertension", "diabetes", "insomnia disorder",
  "sleep apnea", "bipolar", "psychosis", "patholog",
];

/**
 * Instruction / prompt-injection / exfiltration vocabulary. A genuine wellness
 * observation describes a feeling or state; it never issues commands to the
 * system or asks to move data. If a candidate's content reads like an
 * instruction, it is not an observation — reject it regardless of grounding.
 */
export const INJECTION_TERMS = [
  "ignore previous", "ignore all previous", "ignore the above", "disregard previous",
  "disregard all", "previous instructions", "new instructions", "system prompt",
  "you are now", "override", "developer mode",
  "email all", "send all", "forward all", "export all", "upload all", "leak",
  "exfiltrate", "api key", "password", "credentials",
  "rm -rf", "drop table", "delete all", "execute", "run command", "curl ",
  "http://", "https://", "<script", "function(", "tool_call", "call the tool",
];

/** Medication-change vocabulary Wellness must never produce. */
export const MEDICATION_TERMS = [
  "medication", "medicine", "dose", "dosage", "prescrib", "pill", "tablet",
  "mg ", "milligram", "stop taking", "increase your", "double your", "skip your",
];

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it",
  "me", "my", "your", "this", "that", "was", "were", "been", "have", "had",
  "felt", "feel", "feeling", "been", "really", "very", "so", "bit", "little",
  "last", "night", "today", "morning", "this", "i", "im",
]);

/** All explicit numbers mentioned in text: digits and number-words, plus "half". */
function numbersInText(text: string): Set<number> {
  const out = new Set<number>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\b\d+(?:\.\d+)?\b/g)) out.add(parseFloat(m[0]));
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(lower)) {
      out.add(n);
      // "<word> and a half" / "<word> and a half hours"
      if (new RegExp(`\\b${word}\\b[^.]*\\band a half\\b`, "i").test(lower)) out.add(n + 0.5);
    }
  }
  return out;
}

/**
 * Find the source sentence that supports the observation. Needles are tried in
 * priority order (most specific first, e.g. the stated number before the word
 * "sleep") and matched on word boundaries, so evidence points at the sentence
 * that actually contains the value rather than the first loosely related one.
 */
function supportingSentence(source: string, needles: string | string[]): string {
  const list = (Array.isArray(needles) ? needles : [needles]).map((n) => n.toLowerCase()).filter(Boolean);
  const sentences = source.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  for (const n of list) {
    const re = new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i");
    const hit = sentences.find((s) => re.test(s));
    if (hit) return hit.trim().slice(0, 200);
  }
  return (sentences[0] ?? source).trim().slice(0, 200);
}

/** The source sentence sharing the most tokens with a qualitative description. */
function bestOverlapSentence(source: string, tokens: string[]): string {
  const sentences = source.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  let best = sentences[0] ?? source;
  let bestScore = -1;
  for (const s of sentences) {
    const low = s.toLowerCase();
    const score = tokens.filter((t) => low.includes(t)).length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best.trim().slice(0, 200);
}

/** Spelled form of a small number, for evidence matching ("4" -> "four"). */
function numberWord(n: number): string | null {
  const entry = Object.entries(NUMBER_WORDS).find(([, v]) => v === n);
  return entry ? entry[0] : null;
}

function significantTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function containsAny(haystack: string, needles: string[]): string | null {
  const low = haystack.toLowerCase();
  for (const n of needles) if (low.includes(n)) return n;
  return null;
}

function decideOne(candidate: CandidateObservation, source: string): CandidateDecision {
  const type = candidate.type as ObservationType;
  const descr = candidate.description ?? "";
  const combined = `${type} ${descr}`;

  // Layer: injection. A candidate that reads like an instruction or data-exfil
  // request is not a wellness observation, even if the words echo the source.
  const inj = containsAny(combined, INJECTION_TERMS) || /@[\w-]+\.[\w.-]+/.test(descr);
  if (inj) {
    return {
      candidate, verdict: "rejected", layer: "injection",
      reason: `Rejected: content reads like an instruction/exfiltration attempt, not an observation ("${(typeof inj === "string" ? inj : "contact detail").trim()}").`,
      evidence: "",
    };
  }

  // Layer: medical. Never store diagnoses or medication instructions.
  const diag = containsAny(combined, DIAGNOSIS_TERMS);
  if (diag) {
    return {
      candidate, verdict: "rejected", layer: "medical",
      reason: `Rejected: clinical diagnosis ("${diag}") is outside Wellness's non-diagnostic scope.`,
      evidence: "",
    };
  }
  const med = containsAny(combined, MEDICATION_TERMS);
  if (med) {
    return {
      candidate, verdict: "rejected", layer: "medical",
      reason: `Rejected: medication instruction ("${med.trim()}") — Wellness never changes medications.`,
      evidence: "",
    };
  }

  const isQuant = QUANTITATIVE_TYPES.includes(type);

  // Layer: evidence + range for numeric values.
  if (candidate.value !== undefined) {
    const nums = numbersInText(source);
    const grounded = [...nums].some((n) => Math.abs(n - candidate.value!) < 0.01);
    if (!grounded) {
      return {
        candidate, verdict: "rejected", layer: "evidence",
        reason: `Rejected: value ${candidate.value} is not stated in the message (possible hallucinated/invented number).`,
        evidence: "",
      };
    }
    // A numeric value on a non-quantitative type (e.g. energy=2) is an invented rating.
    if (!isQuant) {
      return {
        candidate, verdict: "rejected", layer: "evidence",
        reason: `Rejected: "${type}" is qualitative; a numeric rating was not supported by the message.`,
        evidence: "",
      };
    }
    // Unit must be present and valid for a quantitative value.
    if (!candidate.unit) {
      return {
        candidate, verdict: "rejected", layer: "range",
        reason: `Rejected: ${type} value is missing a unit.`,
        evidence: "",
      };
    }
    const range = VALUE_RANGES[`${type}:${candidate.unit}`];
    if (!range) {
      return {
        candidate, verdict: "rejected", layer: "range",
        reason: `Rejected: unit "${candidate.unit}" is not valid for ${type}.`,
        evidence: "",
      };
    }
    if (candidate.value < range.min || candidate.value > range.max) {
      return {
        candidate, verdict: "rejected", layer: "range",
        reason: `Rejected: ${candidate.value} ${candidate.unit} is outside the plausible range for ${type}.`,
        evidence: "",
      };
    }
    // Prefer the sentence that states the number itself; "sleep"/"slept" alone
    // would pick an earlier sentence like "I haven't been sleeping well."
    const valueNeedles = [String(candidate.value), numberWord(candidate.value) ?? ""].filter(Boolean);
    const byValue = source.split(/(?<=[.!?])\s+|\n+/).find((s) => valueNeedles.some((n) => new RegExp(`\\b${n.replace(".", "\\.")}\\b`, "i").test(s)));
    return {
      candidate, verdict: candidate.requires_confirmation ? "needs_confirmation" : "accepted",
      layer: "ok", reason: "Grounded numeric observation.",
      evidence: byValue ? byValue.trim().slice(0, 200) : supportingSentence(source, [candidate.unit, "slept", "sleep"]),
    };
  }

  // Qualitative observation: description must be supported by the source text.
  if (descr) {
    const descrTokens = significantTokens(descr);
    const sourceLow = source.toLowerCase();
    const overlap = descrTokens.filter((t) => sourceLow.includes(t));
    if (descrTokens.length === 0 || overlap.length === 0) {
      return {
        candidate, verdict: "rejected", layer: "evidence",
        reason: `Rejected: description "${descr}" is not supported by anything in the message.`,
        evidence: "",
      };
    }
    const strong = overlap.length / descrTokens.length >= 0.5;
    const evidence = bestOverlapSentence(source, overlap);
    if (!strong || candidate.requires_confirmation) {
      return {
        candidate, verdict: "needs_confirmation", layer: "ok",
        reason: "Partially supported; confirm with the person before relying on it.",
        evidence,
      };
    }
    return { candidate, verdict: "accepted", layer: "ok", reason: "Supported qualitative observation.", evidence };
  }

  // Quantitative type with no value and no description is empty.
  return {
    candidate, verdict: "rejected", layer: "schema",
    reason: "Rejected: observation has neither a grounded value nor a supported description.",
    evidence: "",
  };
}

/**
 * Validate raw provider output against the schema and the source evidence.
 * `raw` is whatever the provider returned (untrusted). Malformed output yields a
 * single schema-rejected decision rather than throwing (red-team case 14).
 */
export function validateObservations(raw: unknown, sourceText: string): PolicyResult {
  const decisions: CandidateDecision[] = [];

  const top = InferenceOutputSchema.safeParse(raw);
  if (!top.success) {
    // Try to salvage per-candidate if observations is at least an array.
    const maybe = (raw as { observations?: unknown })?.observations;
    if (!Array.isArray(maybe)) {
      return {
        accepted: [], needsConfirmation: [],
        rejected: [{
          candidate: {}, verdict: "rejected", layer: "schema",
          reason: `Rejected: provider output did not match the required schema (${top.error.issues.map((i) => i.message).join("; ")}).`,
          evidence: "",
        }],
        decisions: [],
      };
    }
    for (const item of maybe) {
      const parsed = CandidateObservationSchema.safeParse(item);
      if (!parsed.success) {
        decisions.push({
          candidate: (item ?? {}) as CandidateDecision["candidate"],
          verdict: "rejected", layer: "schema",
          reason: `Rejected: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
          evidence: "",
        });
      } else {
        decisions.push(decideOne(parsed.data, sourceText));
      }
    }
  } else {
    for (const candidate of top.data.observations) decisions.push(decideOne(candidate, sourceText));
  }

  return {
    accepted: decisions.filter((d) => d.verdict === "accepted"),
    needsConfirmation: decisions.filter((d) => d.verdict === "needs_confirmation"),
    rejected: decisions.filter((d) => d.verdict === "rejected"),
    decisions,
  };
}
