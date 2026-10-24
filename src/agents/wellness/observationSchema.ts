import { z } from "zod";

/**
 * Strict schema for structured wellness observations (Part 5, Track A).
 *
 * A candidate observation is what an inference model proposes from a free-text
 * message. It is NOT trusted until the deterministic policy engine
 * (observationPolicy.ts) validates it against this schema AND against the source
 * evidence. The schema is intentionally strict (`.strict()`): unknown fields are
 * rejected rather than silently stripped, so a model cannot smuggle extra data.
 */

/** The only observation types Wellness understands. */
export const OBSERVATION_TYPES = [
  "sleep_duration",
  "sleep_quality",
  "energy",
  "mood",
  "appetite",
  "pain",
  "social",
  "activity",
  "other",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Types that are inherently quantitative (a value + unit makes sense). */
export const QUANTITATIVE_TYPES: ObservationType[] = ["sleep_duration"];

export const OBSERVATION_UNITS = ["hours", "minutes"] as const;
export type ObservationUnit = (typeof OBSERVATION_UNITS)[number];

export const OBSERVATION_SOURCES = ["self_report", "caregiver_report", "inferred"] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

/**
 * A single candidate observation. Either `value`+`unit` (quantitative) or
 * `description` (qualitative) must be present; the policy engine enforces the
 * exact combination per type. `.strict()` rejects any field not listed here.
 */
export const CandidateObservationSchema = z
  .object({
    type: z.enum(OBSERVATION_TYPES),
    value: z.number().finite().optional(),
    unit: z.enum(OBSERVATION_UNITS).optional(),
    description: z.string().min(1).max(200).optional(),
    source: z.enum(OBSERVATION_SOURCES).default("self_report"),
    requires_confirmation: z.boolean().default(false),
  })
  .strict();

export type CandidateObservation = z.infer<typeof CandidateObservationSchema>;

/** The top-level shape an inference provider must return. */
export const InferenceOutputSchema = z
  .object({
    observations: z.array(CandidateObservationSchema).max(12),
  })
  .strict();

export type InferenceOutput = z.infer<typeof InferenceOutputSchema>;

/** A validated, evidence-grounded observation ready to persist, with provenance. */
export interface CanonicalObservation {
  id: string;
  type: ObservationType;
  value?: number;
  unit?: ObservationUnit;
  description?: string;
  source: ObservationSource;
  requiresConfirmation: boolean;
  /** The exact source sentence/evidence that supports this observation. */
  evidence: string;
  provenance: {
    provider: string;
    model: string;
    mode: "live" | "sandbox";
    extractedAt: number;
  };
}

/** Plausible numeric ranges per quantitative type+unit. Rejects impossible values. */
export const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  "sleep_duration:hours": { min: 0, max: 24 },
  "sleep_duration:minutes": { min: 0, max: 1440 },
};
