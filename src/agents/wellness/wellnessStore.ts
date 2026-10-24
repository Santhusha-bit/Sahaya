/**
 * Canonical wellness-observation store (Part 5, Track B — Convex is the source of truth).
 *
 * Observations live in the Wellness agent's scoped memory (namespace = "wellness",
 * so another agent or user can never read them — ScopedMemory enforces this). This
 * module adds the integrity guarantees the red-team suite checks:
 *
 *   - provenance: every record keeps which model/mode produced it.
 *   - dedup:      a duplicate observation (same content, same day) is not stored
 *                 twice, so trends can't be inflated (cases 17, 30).
 *   - correction: correcting an observation updates it IN PLACE and keeps prior
 *                 values in history; readers only ever see the current value
 *                 (case 7 — corrected memory must not return stale data).
 *   - deletion:   soft-delete flips status to "deleted"; the single canonical
 *                 reader `activeObservations` excludes deleted records, and ALL
 *                 downstream readers (trends, analytics, search) consume that
 *                 list — so a deleted observation cannot reappear (cases 6, 29).
 *   - timestamps: createdAt is immutable; corrections touch updatedAt only
 *                 (defends timestamp tampering, case 16).
 */

import { now } from "@/lib/id";
import type { AuditLog } from "@/agents/base/audit";
import type { MemoryRecord, ScopedMemory } from "@/agents/base/types";
import type { CanonicalObservation } from "./observationSchema";

const COLLECTION = "observations";

export interface StoredObservation extends CanonicalObservation {
  recordId: string;
  status: "active" | "deleted";
  contentHash: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  correctedAt?: number;
  history?: { description?: string; value?: number; unit?: string; at: number }[];
}

function dayBucket(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Stable content hash for dedup: same content on the same day is a duplicate. */
export function observationHash(o: Pick<CanonicalObservation, "type" | "value" | "unit" | "description">, ts: number): string {
  const desc = (o.description ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${o.type}|${o.value ?? ""}|${o.unit ?? ""}|${desc}|${dayBucket(ts)}`;
}

function fromRecord(rec: MemoryRecord): StoredObservation {
  return { ...(rec.data as unknown as StoredObservation), recordId: rec.id };
}

/**
 * Persist an accepted observation. Returns { stored, duplicate }. A duplicate is
 * NOT written again; the existing record is returned so callers can rely on it.
 */
export async function saveObservation(
  memory: ScopedMemory,
  obs: CanonicalObservation,
  opts?: { audit?: AuditLog; correlationId?: string },
): Promise<{ stored: StoredObservation; duplicate: boolean }> {
  const ts = obs.provenance.extractedAt || now();
  const hash = observationHash(obs, ts);

  const existing = (await memory.list(COLLECTION)).map(fromRecord);
  const dup = existing.find((e) => e.status === "active" && e.contentHash === hash);
  if (dup) {
    await opts?.audit?.record({
      actor: "wellness",
      action: "observation.dedup",
      correlationId: opts?.correlationId,
      detail: { type: obs.type, hash, keptRecordId: dup.recordId },
    });
    return { stored: dup, duplicate: true };
  }

  const data: Omit<StoredObservation, "recordId"> = {
    ...obs,
    status: "active",
    contentHash: hash,
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  };
  const rec = await memory.save(COLLECTION, data as unknown as Record<string, unknown>, {
    tags: ["observation", obs.type],
  });
  await opts?.audit?.record({
    actor: "wellness",
    action: "observation.save",
    correlationId: opts?.correlationId,
    detail: { recordId: rec.id, type: obs.type, mode: obs.provenance.mode, model: obs.provenance.model },
  });
  return { stored: { ...data, recordId: rec.id }, duplicate: false };
}

/** The ONE canonical reader. Excludes deleted records. All readers use this. */
export async function activeObservations(memory: ScopedMemory): Promise<StoredObservation[]> {
  return (await memory.list(COLLECTION))
    .map(fromRecord)
    .filter((o) => o.status === "active")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Includes deleted — only for the audit/review view, never for trends/analytics. */
export async function allObservations(memory: ScopedMemory): Promise<StoredObservation[]> {
  return (await memory.list(COLLECTION)).map(fromRecord).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Correct an observation in place. The record keeps its createdAt; prior values
 * go to history; version increments. Readers subsequently see only the new value.
 */
export async function correctObservation(
  memory: ScopedMemory,
  recordId: string,
  patch: { description?: string; value?: number; unit?: string },
  opts?: { audit?: AuditLog; correlationId?: string },
): Promise<StoredObservation | null> {
  const rec = await memory.get(recordId);
  if (!rec || rec.collection !== COLLECTION) return null;
  const cur = fromRecord(rec);
  if (cur.status === "deleted") return null;

  const history = cur.history ?? [];
  history.push({ description: cur.description, value: cur.value, unit: cur.unit, at: cur.updatedAt });

  const ts = now();
  const next: Partial<StoredObservation> = {
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...(patch.unit !== undefined ? { unit: patch.unit as StoredObservation["unit"] } : {}),
    version: cur.version + 1,
    updatedAt: ts,
    correctedAt: ts,
    // Re-hash so dedup keeps working on the corrected content.
    contentHash: observationHash(
      {
        type: cur.type,
        value: patch.value ?? cur.value,
        unit: (patch.unit as StoredObservation["unit"]) ?? cur.unit,
        description: patch.description ?? cur.description,
      },
      cur.createdAt,
    ),
    history,
  };
  const updated = await memory.update(recordId, next as Record<string, unknown>);
  await opts?.audit?.record({
    actor: "wellness",
    action: "observation.correct",
    correlationId: opts?.correlationId,
    detail: { recordId, patch, newVersion: cur.version + 1 },
  });
  return updated ? fromRecord(updated) : null;
}

/** Soft-delete. The record stays for audit but no reader of active data sees it. */
export async function deleteObservation(
  memory: ScopedMemory,
  recordId: string,
  opts?: { audit?: AuditLog; correlationId?: string },
): Promise<boolean> {
  const rec = await memory.get(recordId);
  if (!rec || rec.collection !== COLLECTION) return false;
  const updated = await memory.update(recordId, { status: "deleted", deletedAt: now() });
  await opts?.audit?.record({
    actor: "wellness",
    action: "observation.delete",
    correlationId: opts?.correlationId,
    detail: { recordId },
  });
  return !!updated;
}
