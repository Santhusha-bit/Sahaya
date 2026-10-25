/**
 * Wellness full-integration workflow (Part 5, Track B — the main scenario).
 *
 * Ties the pieces together for a single wellness message:
 *   1. Claude/sandbox understands the conversation (handled by the agent runtime).
 *   2. Bitdeer (or sandbox) proposes candidate observations.
 *   3. The deterministic policy engine validates them.
 *   4. Convex (scoped memory) stores the canonical observation.
 *   5. Moss saves permitted continuity context.
 *   6. Backboard stores + retrieves relevant historical context.
 *   7. Tiger Data updates the sleep/energy time series (fed ONLY from canonical
 *      active observations, so deletes and dedup propagate).
 *   8. The historical trend is retrieved.
 *   9. A contextual, NON-DIAGNOSTIC follow-up is composed.
 *
 * Every external step is wrapped so a failure is reported honestly as a failed
 * sync and NEVER corrupts the canonical Convex record or blocks the core turn
 * (defends "failed sync reported as success" and keeps safe functionality alive).
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import { getHistoricalContextProvider, type HistoryHit } from "@/integrations/backboard";
import { getTimeSeriesProvider, type Trend } from "@/integrations/tigerdata";
import { syncContinuity } from "./continuityMemory";
import { extractObservations, type ExtractionResult } from "./extractObservations";
import { activeObservations, saveObservation, type StoredObservation } from "./wellnessStore";

export interface SyncStatus {
  integration: string;
  mode: "live" | "sandbox";
  ok: boolean;
  detail: string;
}

export interface WellnessTurnResult {
  extraction: ExtractionResult;
  savedCount: number;
  duplicates: number;
  continuitySaved: number;
  historical: HistoryHit[];
  sleepTrend: Trend;
  energyTrend: Trend;
  followUp: string;
  syncs: SyncStatus[];
}

function energyScore(o: StoredObservation): number | null {
  if (o.type !== "energy") return null;
  const d = (o.description ?? "").toLowerCase();
  if (/energetic|full of energy|lots of energy/.test(d)) return 4;
  if (/tired|exhausted|worn out|no energy|low energy|fatigued|drained/.test(d)) return 1;
  return null;
}

/** Non-diagnostic, warm follow-up grounded in the trend + whether we've heard this before. */
function composeFollowUp(sleepTrend: Trend, historical: HistoryHit[], accepted: StoredObservation[]): string {
  const mentionedSleep = accepted.some((o) => o.type === "sleep_duration" || o.type === "sleep_quality");
  const heardBefore = historical.length > 0;
  if (mentionedSleep && sleepTrend.direction === "declining") {
    return heardBefore
      ? "I've noticed sleep has come up a few times lately, and it sounds like it's been harder recently. I'm really glad you're telling me. What do you think has been keeping you up?"
      : "Thank you for sharing that. It sounds like sleep has been harder lately. Would it help to talk about what's on your mind at night?";
  }
  if (mentionedSleep && sleepTrend.count >= 3 && sleepTrend.direction === "improving") {
    return "It sounds like your sleep has been a little better lately, which is lovely to hear. What do you think has helped?";
  }
  if (mentionedSleep) {
    return "Thank you for telling me about your sleep. I'll keep track gently so we can notice any patterns together.";
  }
  return "Thank you for sharing that with me. I'm here, and I'm listening.";
}

export async function runWellnessTurn(opts: {
  text: string;
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  audit?: AuditLog;
  correlationId?: string;
}): Promise<WellnessTurnResult> {
  const { memory, userId, consent } = opts;
  const syncs: SyncStatus[] = [];

  // Steps 2-3: extract + validate.
  const extraction = await extractObservations({
    text: opts.text,
    consent,
    audit: opts.audit,
    correlationId: opts.correlationId,
  });

  // Step 4: persist canonical (Convex / scoped memory). This is the source of truth.
  let savedCount = 0;
  let duplicates = 0;
  for (const obs of extraction.accepted) {
    const { duplicate } = await saveObservation(memory, obs, { audit: opts.audit, correlationId: opts.correlationId });
    if (duplicate) duplicates++;
    else savedCount++;
  }

  // Step 5: continuity cues via the permission-aware adapter (Convex ledger
  // canonical, minimized cues to Moss). A Moss failure is reported, not fatal.
  let continuitySaved = 0;
  if (consent.wellnessMemory) {
    const c = await syncContinuity({ memory, userId, consent, text: opts.text, audit: opts.audit, correlationId: opts.correlationId });
    continuitySaved = c.upserted;
    syncs.push({ integration: "moss", mode: c.backend === "moss" ? "live" : "sandbox", ok: c.mossOk, detail: c.detail });
  }

  // Step 6: Backboard — store a short de-identified summary + retrieve relevant history.
  let historical: HistoryHit[] = [];
  if (consent.wellnessMemory) {
    try {
      const bb = getHistoricalContextProvider();
      historical = await bb.retrieve({ userId, query: opts.text, limit: 3 });
      if (extraction.accepted.length) {
        const topic = extraction.accepted.map((o) => o.type).join(", ");
        const summary = extraction.accepted.map((o) => (o.value !== undefined ? `${o.type} ${o.value}${o.unit ?? ""}` : `${o.type}: ${o.description}`)).join("; ");
        await bb.store({ userId, topic, summary });
      }
      syncs.push({ integration: "backboard", mode: bb.backend === "backboard" ? "live" : "sandbox", ok: true, detail: `${historical.length} relevant memory(ies) retrieved.` });
    } catch (err) {
      syncs.push({ integration: "backboard", mode: "live", ok: false, detail: `Backboard failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Step 7: Tiger Data — sync ONLY canonical active observations (idempotent).
  const active = await activeObservations(memory);
  let sleepTrend: Trend = { metric: "sleep", count: 0, average: null, latest: null, direction: "insufficient_data", points: [] };
  let energyTrend: Trend = { metric: "energy", count: 0, average: null, latest: null, direction: "insufficient_data", points: [] };
  try {
    const ts = getTimeSeriesProvider();
    let appended = 0;
    for (const o of active) {
      if (o.type === "sleep_duration" && o.value !== undefined) {
        if (await ts.append({ observationId: o.id, userId, metric: "sleep", value: o.value, unit: o.unit ?? "hours", at: o.createdAt })) appended++;
      }
      const es = energyScore(o);
      if (es !== null) {
        if (await ts.append({ observationId: o.id, userId, metric: "energy", value: es, unit: "score", at: o.createdAt })) appended++;
      }
    }
    // Step 8: retrieve the trends.
    sleepTrend = await ts.trend({ userId, metric: "sleep" });
    energyTrend = await ts.trend({ userId, metric: "energy" });
    syncs.push({ integration: "tigerdata", mode: ts.backend === "tigerdata" ? "live" : "sandbox", ok: true, detail: `${appended} new point(s); sleep trend ${sleepTrend.direction}.` });
  } catch (err) {
    syncs.push({ integration: "tigerdata", mode: "live", ok: false, detail: `Tiger Data failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Step 9: contextual, non-diagnostic follow-up.
  const followUp = composeFollowUp(sleepTrend, historical, active);

  await opts.audit?.record({
    actor: "wellness",
    action: "wellness.turn",
    correlationId: opts.correlationId,
    detail: { saved: savedCount, duplicates, continuitySaved, historical: historical.length, syncs: syncs.map((s) => ({ i: s.integration, ok: s.ok })) },
  });

  return { extraction, savedCount, duplicates, continuitySaved, historical, sleepTrend, energyTrend, followUp, syncs };
}
