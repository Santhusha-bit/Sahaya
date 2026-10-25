/**
 * Incident indexing job (Track 4).
 *
 * The incident of record lives in the data layer (Convex when configured). This
 * job projects each saved incident onto an explicit ALLOWLIST of fields, redacts
 * PII from the text, and writes it to the search index. Anything not on the
 * allowlist (verification contacts, caregiver names, phone numbers, policy
 * internals) never leaves for the index. Indexing only happens when the person's
 * `guardianIncidentSearch` consent is on.
 *
 * Two entry points:
 *   - indexIncident: index one record right after it is saved (the live flow).
 *   - runIncidentIndexJob: backfill/re-index every saved incident for a user.
 */

import { getConsent } from "../consent";
import { getIncidentIndex, redactPII, scamTypeFromSignals, type IncidentDoc, type IncidentSearchIndex } from "@/integrations/search";
import type { DataLayer } from "../base/types";
import { detectSignals } from "./scamSignals";

export const INCIDENT_SEARCH_CONSENT = "guardianIncidentSearch";

export type IndexStatus = "indexed" | "skipped_no_consent" | "skipped_empty" | "failed";

export interface IndexResult {
  incidentId: string;
  status: IndexStatus;
  error?: string;
}

/** Signal codes from a stored incident: ScamSignal objects, bare codes, or none. */
function storedSignalCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === "string" ? s : s && typeof s === "object" ? String((s as { code?: unknown }).code ?? "") : ""))
    .filter(Boolean);
}

/**
 * Allowlisted projection of a saved incident. Returns null when there is no text
 * to index. Only the fields named here are ever sent to the search index.
 */
export function toIncidentDoc(record: Record<string, unknown>, userId: string, fallbackId?: string): IncidentDoc | null {
  const rawText = String(record.rawMessage ?? record.summary ?? "").trim();
  if (!rawText) return null;
  const text = redactPII(rawText);

  // Re-derive signals from the redacted text when the record has none stored
  // (e.g. seeded history), so tactic similarity works for every incident.
  const detected = detectSignals(text).signals;
  let signals = storedSignalCodes(record.signals);
  if (!signals.length) signals = detected.map((s) => s.code);
  const labelByCode = new Map(detected.map((s) => [s.code, s.label]));
  if (Array.isArray(record.signals)) {
    for (const s of record.signals) {
      if (s && typeof s === "object" && "code" in s && "label" in s) {
        labelByCode.set(String((s as { code: unknown }).code), String((s as { label: unknown }).label));
      }
    }
  }

  return {
    incidentId: String(record.id ?? fallbackId ?? ""),
    userId,
    channel: String(record.channel ?? "other"),
    scamType: String(record.scamType ?? scamTypeFromSignals(signals)),
    riskLevel: String(record.riskLevel ?? "medium"),
    outcome: record.outcome ? String(record.outcome) : undefined,
    receivedAt: Number(record.receivedAt ?? Date.now()),
    text,
    signals,
    tactics: signals.map((c) => labelByCode.get(c)).filter((l): l is string => !!l),
  };
}

/** Index one saved incident. Never throws: indexing must not break screening. */
export async function indexIncident(
  record: Record<string, unknown>,
  opts: { userId: string; permitted: boolean; index?: IncidentSearchIndex; fallbackId?: string },
): Promise<IndexResult> {
  const incidentId = String(record.id ?? opts.fallbackId ?? "");
  if (!opts.permitted) return { incidentId, status: "skipped_no_consent" };
  const doc = toIncidentDoc(record, opts.userId, opts.fallbackId);
  if (!doc || !doc.incidentId) return { incidentId, status: "skipped_empty" };
  try {
    await (opts.index ?? getIncidentIndex()).index(doc);
    return { incidentId, status: "indexed" };
  } catch (err) {
    return { incidentId, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read the person's consent for incident search (defaults to on). */
export function incidentSearchPermitted(consent: Record<string, boolean | undefined>): boolean {
  return consent[INCIDENT_SEARCH_CONSENT] !== false;
}

/**
 * Backfill job: index every saved Guardian incident for a user from the data
 * layer (Convex when live). Idempotent: documents are keyed by incident id.
 */
export async function runIncidentIndexJob(
  data: DataLayer,
  userId: string,
  index: IncidentSearchIndex = getIncidentIndex(),
): Promise<{ indexed: number; skipped: number; failed: number; results: IndexResult[] }> {
  const permitted = incidentSearchPermitted(await getConsent(data, userId));
  const rows = await data.memory.list({ namespace: "guardian", userId, collection: "incidents" });
  const results: IndexResult[] = [];
  for (const r of rows) {
    results.push(await indexIncident(r.data, { userId, permitted, index, fallbackId: r.id }));
  }
  return {
    indexed: results.filter((r) => r.status === "indexed").length,
    skipped: results.filter((r) => r.status.startsWith("skipped")).length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  };
}
