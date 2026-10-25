/**
 * Tiger Data synchronization job (Convex -> Tiger Data).
 *
 * Convex (the Wellness agent's scoped memory) is canonical. This job mirrors
 * the APPROVED NUMERIC observations into the time-series provider:
 *
 *   - Only active canonical records are read (`activeObservations`), so a
 *     deleted observation is never synced.
 *   - Only approved records: anything still awaiting confirmation is excluded.
 *   - Only numeric metrics: reported sleep duration (hours) and an energy
 *     rating. Free text never leaves Convex.
 *   - It RECONCILES rather than appends: points whose canonical record was
 *     corrected are updated, and points whose canonical record was deleted are
 *     removed from the mirror. Re-running is idempotent.
 *   - Consent: with `wellnessTimeSeriesSync` off, nothing is written and the
 *     user's existing mirror is purged.
 *
 * The job never throws and never touches the canonical record: a Tiger Data
 * outage is reported as a failed sync, and the next run catches up.
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import { getTimeSeriesProvider, METRIC_UNIT, type SeriesPoint, type TimeSeriesProvider } from "@/integrations/tigerdata";
import { now } from "@/lib/id";
import { activeObservations, type StoredObservation } from "./wellnessStore";

export const TIMESERIES_CONSENT_KEY = "wellnessTimeSeriesSync";
const STATE_COLLECTION = "timeseriesSync";

export interface SyncRun {
  ok: boolean;
  backend: "tigerdata" | "sandbox";
  status: "synced" | "purged_no_consent" | "failed";
  /** Approved numeric observations eligible for the mirror. */
  eligible: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Canonical observations skipped (not numeric, or awaiting confirmation). */
  skipped: number;
  ranAt: number;
  error?: string;
}

/**
 * Map an energy description to a 1-5 rating. Sahaya only records energy as
 * words ("felt exhausted"), so this is a coarse, DERIVED rating; the dashboard
 * labels it that way. Returns null when the words carry no clear level.
 */
export function energyRating(o: Pick<StoredObservation, "type" | "description">): number | null {
  if (o.type !== "energy") return null;
  const d = (o.description ?? "").toLowerCase();
  if (/exhausted|no energy|drained|worn out/.test(d)) return 1;
  if (/tired|low energy|fatigued/.test(d)) return 2;
  if (/full of energy|lots of energy/.test(d)) return 5;
  if (/energetic/.test(d)) return 4;
  return null;
}

/** The single mapping from a canonical observation to a mirrored numeric point. */
export function toSeriesPoint(o: StoredObservation, userId: string): SeriesPoint | null {
  if (o.requiresConfirmation) return null;
  const base = { observationId: o.id, userId, observedAt: o.createdAt, recordedAt: o.updatedAt, source: o.source };
  if (o.type === "sleep_duration" && o.value !== undefined) {
    const hours = o.unit === "minutes" ? Math.round((o.value / 60) * 100) / 100 : o.value;
    return { ...base, metric: "sleep", value: hours, unit: METRIC_UNIT.sleep };
  }
  const rating = energyRating(o);
  if (rating !== null) return { ...base, metric: "energy", value: rating, unit: METRIC_UNIT.energy };
  return null;
}

async function saveState(memory: ScopedMemory, run: SyncRun): Promise<void> {
  const [existing] = await memory.list(STATE_COLLECTION);
  const data = run as unknown as Record<string, unknown>;
  if (existing) await memory.update(existing.id, data);
  else await memory.save(STATE_COLLECTION, data, { tags: ["timeseries"] });
}

/** The last sync run for this user (shown on the dashboard as freshness). */
export async function lastSyncRun(memory: ScopedMemory): Promise<SyncRun | null> {
  const [existing] = await memory.list(STATE_COLLECTION);
  return existing ? (existing.data as unknown as SyncRun) : null;
}

export async function syncWellnessTimeSeries(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  provider?: TimeSeriesProvider;
  audit?: AuditLog;
  correlationId?: string;
}): Promise<SyncRun> {
  const { memory, userId } = opts;
  const ts = opts.provider ?? getTimeSeriesProvider();
  const run: SyncRun = {
    ok: true,
    backend: ts.backend,
    status: "synced",
    eligible: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    skipped: 0,
    ranAt: now(),
  };

  try {
    if (opts.consent[TIMESERIES_CONSENT_KEY] === false) {
      run.status = "purged_no_consent";
      run.removed = await ts.purgeUser(userId);
    } else {
      const active = await activeObservations(memory);
      const desired: SeriesPoint[] = [];
      for (const o of active) {
        const p = toSeriesPoint(o, userId);
        if (p) desired.push(p);
        else run.skipped++;
      }
      run.eligible = desired.length;

      // Reconcile: anything mirrored that is no longer an approved canonical
      // point (deleted, or flipped to needs-confirmation) is removed.
      const keep = new Set(desired.map((p) => p.observationId));
      const stale = (await ts.points({ userId })).filter((p) => !keep.has(p.observationId)).map((p) => p.observationId);
      run.removed = await ts.remove(userId, stale);

      const res = await ts.upsert(desired);
      run.inserted = res.inserted;
      run.updated = res.updated;
      run.unchanged = res.unchanged;
    }
  } catch (err) {
    run.ok = false;
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
  }

  await saveState(memory, run).catch(() => {});
  await opts.audit?.record({
    actor: "wellness",
    action: "timeseries.sync",
    correlationId: opts.correlationId,
    detail: {
      backend: run.backend,
      status: run.status,
      ok: run.ok,
      eligible: run.eligible,
      inserted: run.inserted,
      updated: run.updated,
      removed: run.removed,
      ...(run.error ? { error: run.error } : {}),
    },
  });
  return run;
}
