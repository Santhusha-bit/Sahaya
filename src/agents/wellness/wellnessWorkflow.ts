/**
 * Wellness full-integration workflow (Part 5, Track B — the main scenario).
 *
 * Ties the pieces together for a single wellness message:
 *   1. Claude/sandbox understands the conversation (handled by the agent runtime).
 *   2. Bitdeer (or sandbox) proposes candidate observations.
 *   3. The deterministic policy engine validates them.
 *   4. Convex (scoped memory) stores the canonical observation.
 *   5. Moss saves permitted continuity context.
 *   6. Backboard recalls verified long-term conversational context (hobbies,
 *      family visits) and indexes any new context from this turn. Health
 *      observations are NOT copied into Backboard (see conversationContext.ts).
 *   7. The sync job mirrors approved numeric observations into Tiger Data,
 *      reconciling against canonical active records so corrections, deletes
 *      and dedup propagate (timeSeriesSync.ts).
 *   8. The weekly trend is read back and compared with the person's history
 *      (longitudinalTrends.ts).
 *   9. A contextual, NON-DIAGNOSTIC follow-up is composed.
 *
 * Every external step is wrapped so a failure is reported honestly as a failed
 * sync and NEVER corrupts the canonical Convex record or blocks the core turn
 * (defends "failed sync reported as success" and keeps safe functionality alive).
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import { computeTrend, emptyTrend, getTimeSeriesProvider, type Trend } from "@/integrations/tigerdata";
import { syncContinuity } from "./continuityMemory";
import { continueFromContext, recallConversationContext, saveConversationContext, type RecalledContext } from "./conversationContext";
import { extractObservations, type ExtractionResult } from "./extractObservations";
import { getLongitudinalTrend, type LongitudinalTrend } from "./longitudinalTrends";
import { syncWellnessTimeSeries, type SyncRun } from "./timeSeriesSync";
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
  /** Verified long-term context recalled via Backboard (canonical Convex text). */
  recalled: RecalledContext[];
  contextSaved: number;
  sleepTrend: Trend;
  energyTrend: Trend;
  /** This week's sleep compared with the person's own history (null if unavailable). */
  sleepHistory: LongitudinalTrend | null;
  timeSeriesSync: SyncRun | null;
  followUp: string;
  syncs: SyncStatus[];
}

/** Non-diagnostic, warm follow-up grounded in the trend, her own baseline, and what she has told us before. */
function composeFollowUp(
  sleepTrend: Trend,
  sleepHistory: LongitudinalTrend | null,
  recalled: RecalledContext[],
  accepted: { type: string }[],
  active: StoredObservation[],
): string {
  const isSleep = (o: { type: string }) => o.type === "sleep_duration" || o.type === "sleep_quality";
  const mentionedSleep = accepted.some(isSleep);
  const heardBefore = active.filter(isSleep).length > 1;
  const usual = sleepHistory?.baseline.average;
  if (mentionedSleep && sleepHistory?.comparison.direction === "lower" && usual != null) {
    return `Thank you for telling me. That's been a bit less sleep than your usual of around ${usual} hours over the past few weeks. How have the nights been feeling for you?`;
  }
  if (mentionedSleep && sleepHistory?.comparison.direction === "higher" && usual != null) {
    return `It sounds like you've been sleeping a little more than your usual of around ${usual} hours lately. How are you feeling during the day?`;
  }
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
  return continueFromContext(recalled) ?? "Thank you for sharing that with me. I'm here, and I'm listening.";
}

export async function runWellnessTurn(opts: {
  text: string;
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  audit?: AuditLog;
  correlationId?: string;
  /** Injectable clock (demo/tests simulate "days later"). */
  now?: number;
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
  syncs.push({
    integration: "bitdeer",
    mode: extraction.provenance.mode,
    ok: !extraction.inferenceError,
    detail: extraction.inferenceError
      ? `Inference failed, nothing extracted: ${extraction.inferenceError}`
      : `${extraction.provenance.model} request ${extraction.provenance.requestId ?? "n/a"}: ${extraction.accepted.length} accepted, ${extraction.rejected.length} rejected.`,
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

  // Step 6: Backboard. Recall first (so this turn's words are not "remembered"
  // back at her), then index any new permitted context. Consent is enforced
  // inside both calls; a failure is reported, never fatal.
  let recalled: RecalledContext[] = [];
  let contextSaved = 0;
  try {
    const recall = await recallConversationContext({ memory, userId, consent, query: opts.text, audit: opts.audit, correlationId: opts.correlationId, now: opts.now });
    recalled = recall.recalled;
    const save = await saveConversationContext({ memory, userId, consent, text: opts.text, audit: opts.audit, correlationId: opts.correlationId, now: opts.now });
    contextSaved = save.saved.length;
    if (!recall.blocked) {
      syncs.push({ integration: "backboard", mode: recall.mode, ok: save.sync?.ok ?? true, detail: `${recall.detail} ${save.sync?.detail ?? ""}`.trim() });
    }
  } catch (err) {
    syncs.push({ integration: "backboard", mode: "live", ok: false, detail: `Backboard failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Step 7: sync job mirrors approved numeric observations into Tiger Data.
  const active = await activeObservations(memory);
  const ts = getTimeSeriesProvider();
  const mode = ts.backend === "tigerdata" ? "live" : "sandbox";
  let sleepTrend = emptyTrend("sleep");
  let energyTrend = emptyTrend("energy");
  let sleepHistory: LongitudinalTrend | null = null;
  const timeSeriesSync = await syncWellnessTimeSeries({ memory, userId, consent, provider: ts, audit: opts.audit, correlationId: opts.correlationId });
  if (!timeSeriesSync.ok) {
    syncs.push({ integration: "tigerdata", mode, ok: false, detail: `Tiger Data sync failed: ${timeSeriesSync.error}` });
  } else if (timeSeriesSync.status === "purged_no_consent") {
    syncs.push({ integration: "tigerdata", mode, ok: true, detail: `Time-series sync is off by consent; ${timeSeriesSync.removed} mirrored point(s) purged.` });
  } else {
    // Step 8: read the series back and compare this week with the person's history.
    try {
      const points = await ts.points({ userId });
      sleepTrend = computeTrend(points, "sleep");
      energyTrend = computeTrend(points, "energy");
      sleepHistory = await getLongitudinalTrend({ memory, userId, metric: "sleep", provider: ts });
      const s = timeSeriesSync;
      const vsUsual = sleepHistory.comparison.direction === "insufficient" ? "has no baseline yet" : `is ${sleepHistory.comparison.direction} vs usual`;
      syncs.push({ integration: "tigerdata", mode, ok: true, detail: `${s.inserted} new, ${s.updated} updated, ${s.removed} removed; sleep this week ${vsUsual}.` });
    } catch (err) {
      syncs.push({ integration: "tigerdata", mode, ok: false, detail: `Tiger Data read failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Step 9: contextual, non-diagnostic follow-up.
  const followUp = composeFollowUp(sleepTrend, sleepHistory, recalled, extraction.accepted, active);

  await opts.audit?.record({
    actor: "wellness",
    action: "wellness.turn",
    correlationId: opts.correlationId,
    detail: { saved: savedCount, duplicates, continuitySaved, recalled: recalled.length, contextSaved, syncs: syncs.map((s) => ({ i: s.integration, ok: s.ok })) },
  });

  return { extraction, savedCount, duplicates, continuitySaved, recalled, contextSaved, sleepTrend, energyTrend, sleepHistory, timeSeriesSync, followUp, syncs };
}
