/**
 * Wellness observation extraction pipeline (Part 5, Track A, full workflow).
 *
 * Orchestrates the nine steps for turning a free-text wellness message into
 * trustworthy structured observations:
 *   1. consent check for external processing,
 *   2. privacy minimization of the text,
 *   3. provider inference (Bitdeer when live+consented, else sandbox),
 *   4-8. strict schema validation + evidence grounding (observationPolicy),
 *   9. provenance-tagged canonical observations returned to the caller.
 *
 * The provider is strictly advisory. Every trust decision is made in deterministic
 * code here and in observationPolicy.ts, never by the model or a prompt. The
 * caller persists the accepted observations (wellnessStore.ts).
 */

import { id, now } from "@/lib/id";
import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import {
  getWellnessInferenceProvider,
  SandboxWellnessInferenceAdapter,
  type WellnessInferenceProvider,
} from "@/integrations/bitdeer";
import { minimizeForExternal } from "./privacyFilter";
import { validateObservations, type CandidateDecision } from "./observationPolicy";
import type { CanonicalObservation, ObservationSource, ObservationType, ObservationUnit } from "./observationSchema";

export interface ExtractionProvenance {
  provider: string;
  model: string;
  mode: "live" | "sandbox";
  /** True when we fell back to the sandbox because external processing was not consented. */
  externalSkipped: boolean;
  redactions: number;
  redactedKinds: string[];
}

export interface ExtractionResult {
  accepted: CanonicalObservation[];
  needsConfirmation: CanonicalObservation[];
  rejected: CandidateDecision[];
  decisions: CandidateDecision[];
  provenance: ExtractionProvenance;
}

/**
 * Decide which provider may process this text. External (live) processing is only
 * allowed with explicit consent; otherwise we transparently fall back to the
 * offline sandbox extractor so no data leaves the device (red-team case 6).
 */
export function resolveProvider(
  consent: ConsentSettings,
  override?: WellnessInferenceProvider,
): { provider: WellnessInferenceProvider; externalSkipped: boolean } {
  const provider = override ?? getWellnessInferenceProvider();
  if (provider.mode === "live" && !consent.wellnessExternalProcessing) {
    return { provider: new SandboxWellnessInferenceAdapter(), externalSkipped: true };
  }
  return { provider, externalSkipped: false };
}

function toCanonical(d: CandidateDecision, prov: { provider: string; model: string; mode: "live" | "sandbox" }): CanonicalObservation {
  const c = d.candidate;
  return {
    id: id("obs"),
    type: c.type as ObservationType,
    value: c.value,
    unit: c.unit as ObservationUnit | undefined,
    description: c.description,
    source: (c.source as ObservationSource) ?? "self_report",
    requiresConfirmation: d.verdict === "needs_confirmation" || !!c.requires_confirmation,
    evidence: d.evidence,
    provenance: { provider: prov.provider, model: prov.model, mode: prov.mode, extractedAt: now() },
  };
}

export async function extractObservations(opts: {
  text: string;
  consent: ConsentSettings;
  provider?: WellnessInferenceProvider;
  audit?: AuditLog;
  correlationId?: string;
}): Promise<ExtractionResult> {
  const { text, consent } = opts;

  // Step 1-2: consent gate + privacy minimization.
  const { provider, externalSkipped } = resolveProvider(consent, opts.provider);
  const minimized = provider.mode === "live" ? minimizeForExternal(text) : { text, redactions: 0, redactedKinds: [] as string[] };

  await opts.audit?.record({
    actor: "wellness",
    action: "observation.extract.start",
    correlationId: opts.correlationId,
    detail: {
      provider: provider.name,
      model: provider.model,
      mode: provider.mode,
      externalSkipped,
      redactions: minimized.redactions,
      sentChars: minimized.text.length,
    },
  });

  // Step 3: inference (advisory). A provider failure must not corrupt anything.
  let raw: unknown = { observations: [] };
  let inferenceError: string | undefined;
  try {
    const result = await provider.infer({ text: minimized.text });
    raw = result.raw;
  } catch (err) {
    inferenceError = err instanceof Error ? err.message : String(err);
  }

  // Step 4-8: strict validation + evidence grounding against the ORIGINAL text.
  const policy = validateObservations(raw, text);

  const prov = { provider: provider.name, model: provider.model, mode: provider.mode };
  const accepted = policy.accepted.map((d) => toCanonical(d, prov));
  const needsConfirmation = policy.needsConfirmation.map((d) => toCanonical(d, prov));

  await opts.audit?.record({
    actor: "wellness",
    action: "observation.extract.done",
    correlationId: opts.correlationId,
    detail: {
      accepted: accepted.length,
      needsConfirmation: needsConfirmation.length,
      rejected: policy.rejected.length,
      rejections: policy.rejected.map((r) => ({ type: r.candidate.type, reason: r.reason, layer: r.layer })),
      inferenceError,
    },
  });

  return {
    accepted,
    needsConfirmation,
    rejected: policy.rejected,
    decisions: policy.decisions,
    provenance: {
      provider: provider.name,
      model: provider.model,
      mode: provider.mode,
      externalSkipped,
      redactions: minimized.redactions,
      redactedKinds: minimized.redactedKinds,
    },
  };
}
