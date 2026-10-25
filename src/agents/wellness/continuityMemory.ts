/**
 * Permission-aware continuity memory adapter (Convex canonical, Moss for retrieval).
 *
 * Moss gives fast retrieval but documents no encryption-at-rest, retention or
 * compliance guarantees (see integrations/moss.ts), so this adapter decides, in
 * code, what is allowed to leave Convex:
 *
 *   - consent:        nothing is written or read unless `wellnessMemory` consent
 *                     is on, re-read every call.
 *   - minimization:   Moss receives only short TEMPLATED cues ("Sleep came up:
 *                     hasn't been sleeping well."), never the person's raw words,
 *                     numeric health values, timestamps of specific nights, or
 *                     identifiers. Doc ids are opaque; the subject is a salted
 *                     pseudonym. The userId -> doc id ledger lives only in Convex.
 *   - sensitivity:    pain/appetite observations, anything with medication or
 *                     diagnosis vocabulary, and identifiers (a preferred name)
 *                     are kept Convex-only and recorded as such.
 *   - retrieval:      Moss is asked only for the doc ids in THIS user's Convex
 *                     ledger; every returned doc must match the ledger subject
 *                     and text, otherwise it is dropped (tamper / cross-user
 *                     defence). Retrieved text is inert context, never instructions.
 *   - propagation:    cues are rebuilt from the canonical active observations, so
 *                     corrections and deletions flow to Moss; a cue the person
 *                     deletes stays suppressed until they bring the topic up again.
 *   - degradation:    if Moss fails, Convex still holds the ledger and serves the
 *                     continuity context; the failure is reported, never hidden.
 */

import { createHmac } from "node:crypto";
import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { MemoryRecord, ScopedMemory } from "@/agents/base/types";
import { now } from "@/lib/id";
import { getPersonalMemoryProvider, mossSubject, type MossDoc } from "@/integrations/moss";
import { DIAGNOSIS_TERMS, INJECTION_TERMS, MEDICATION_TERMS } from "./observationPolicy";
import { minimizeForExternal } from "./privacyFilter";
import { activeObservations, type StoredObservation } from "./wellnessStore";

const COLLECTION = "memoryRecords";
/** Only observations this recent shape the continuity cue for a topic. */
const TOPIC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ContinuityTopic = "sleep" | "energy" | "mood" | "social" | "activity" | "preference";
export type ContinuitySignal = "poor" | "good" | "tired" | "energetic" | "low" | "positive" | "mentioned";
export type SyncState = "synced" | "failed" | "convex_only";

export interface ContinuityRecord {
  recordId: string;
  /** Opaque Moss doc id (no personal data). */
  docId: string;
  topic: ContinuityTopic;
  signal: ContinuitySignal;
  /** The minimized cue. Exactly what Moss holds when sync === "synced". */
  text: string;
  sync: SyncState;
  /** Why a record stayed Convex-only, for the review UI and audit. */
  reason?: string;
  sourceObservationIds: string[];
  status: "active" | "deleted";
  createdAt: number;
  updatedAt: number;
  /** When the topic was last raised by the person (drives recency ranking). */
  lastDiscussedAt: number;
  deletedAt?: number;
  /** "user" deletions suppress re-creation until the topic is raised again. */
  deletedBy?: "user" | "system";
}

export interface RetrievedContinuity {
  items: ContinuityRecord[];
  source: "moss" | "convex_fallback" | "convex" | "none";
  /** Moss docs rejected by verification (tampered, wrong subject, injection). */
  dropped: number;
  detail: string;
}

export interface ContinuitySyncResult {
  upserted: number;
  removed: number;
  convexOnly: number;
  mossOk: boolean;
  backend: "moss" | "sandbox";
  detail: string;
}

function docIdFor(userId: string, key: string): string {
  const salt = process.env.MOSS_SUBJECT_SALT?.trim() || "sahaya-dev-salt";
  return `kc_${createHmac("sha256", salt).update(`${userId}:${key}`).digest("hex").slice(0, 24)}`;
}

function fromRecord(r: MemoryRecord): ContinuityRecord {
  return { ...(r.data as unknown as Omit<ContinuityRecord, "recordId">), recordId: r.id };
}

async function ledger(memory: ScopedMemory): Promise<ContinuityRecord[]> {
  return (await memory.list(COLLECTION)).map(fromRecord);
}

function containsAny(text: string, terms: readonly string[]): boolean {
  const t = text.toLowerCase();
  return terms.some((term) => t.includes(term));
}

/** True if text must never be sent to Moss or treated as anything but data. */
export function unsafeForMoss(text: string): string | null {
  if (containsAny(text, INJECTION_TERMS)) return "instruction-like content";
  if (containsAny(text, MEDICATION_TERMS)) return "medication content";
  if (containsAny(text, DIAGNOSIS_TERMS)) return "diagnosis content";
  if (/\d/.test(text)) return "numeric detail";
  if (minimizeForExternal(text).redactions > 0) return "personal identifier";
  return null;
}

// ---------------------------------------------------------------------------
// Cue derivation: canonical observations -> one templated cue per topic.
// ---------------------------------------------------------------------------

const POOR_SLEEP = /poor|bad|badly|not well|hardly|trouble|restless|woke|awake|toss|couldn'?t sleep|can'?t sleep|haven'?t been sleeping|little sleep/;
const GOOD_SLEEP = /well|great|good|soundly|rested|better/;
const LOW_MOOD = /lonely|sad|low|down|anxious|worried|upset|isolated|alone|blue/;
const TIRED = /tired|exhausted|worn out|no energy|low energy|fatigued|drained/;

interface Cue {
  topic: ContinuityTopic;
  signal: ContinuitySignal;
  text: string;
}

function cueFor(o: StoredObservation): Cue | { convexOnly: string; topic: ContinuityTopic } | null {
  const d = (o.description ?? "").toLowerCase();
  switch (o.type) {
    case "sleep_duration": {
      const hours = o.unit === "minutes" ? (o.value ?? 0) / 60 : (o.value ?? 0);
      return hours > 0 && hours < 6.5
        ? { topic: "sleep", signal: "poor", text: "Sleep came up: hasn't been sleeping well." }
        : { topic: "sleep", signal: "good", text: "Sleep came up: has been sleeping well." };
    }
    case "sleep_quality":
      if (POOR_SLEEP.test(d)) return { topic: "sleep", signal: "poor", text: "Sleep came up: hasn't been sleeping well." };
      if (GOOD_SLEEP.test(d)) return { topic: "sleep", signal: "good", text: "Sleep came up: has been sleeping well." };
      return { topic: "sleep", signal: "mentioned", text: "Sleep came up in conversation." };
    case "energy":
      return TIRED.test(d)
        ? { topic: "energy", signal: "tired", text: "Energy came up: has been feeling tired." }
        : { topic: "energy", signal: "energetic", text: "Energy came up: has been feeling energetic." };
    case "mood":
      return LOW_MOOD.test(d)
        ? { topic: "mood", signal: "low", text: "Mood came up: has been feeling low." }
        : { topic: "mood", signal: "positive", text: "Mood came up: has been in good spirits." };
    case "social":
      return LOW_MOOD.test(d)
        ? { topic: "social", signal: "low", text: "Company came up: has been feeling lonely." }
        : { topic: "social", signal: "positive", text: "Company came up: enjoyed time with others." };
    case "activity":
      return { topic: "activity", signal: "mentioned", text: "Talked about staying active." };
    case "pain":
    case "appetite":
      return { convexOnly: `${o.type} is health information; kept in Convex only`, topic: "mood" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Preferences: deterministic extraction from the person's own words.
// ---------------------------------------------------------------------------

export interface PreferenceCandidate {
  key: string;
  text: string;
  convexOnly?: string;
}

/** Extract "I love gardening" / "I prefer mornings" / "call me Maggie". */
export function extractPreferences(raw: string): PreferenceCandidate[] {
  const out: PreferenceCandidate[] = [];
  const text = raw.replace(/\s+/g, " ").trim();
  const like = /\bI (?:really |just |do )?(love|enjoy|like|prefer) ([a-zA-Z][a-zA-Z ,'-]{2,48}?)(?=[.!?;]|$| but | because | when )/gi;
  for (const m of text.matchAll(like)) {
    const verb = m[1].toLowerCase();
    const object = m[2]
      .toLowerCase()
      .replace(/\b(though|too|as well|very much|so much|a lot|anyway|really)\s*$/, "")
      .replace(/[ ,'-]+$/, "")
      .trim();
    if (!object || /^(it|that|this|you|to talk|talking to you)$/.test(object)) continue;
    const phrase = verb === "prefer" ? `Prefers ${object}.` : `Enjoys ${object}.`;
    const unsafe = unsafeForMoss(`${verb} ${object}`);
    if (unsafe && unsafe !== "personal identifier") continue; // never keep instruction/medical content at all
    out.push({ key: `pref:${verb === "prefer" ? "prefers" : "enjoys"}:${object}`, text: phrase, convexOnly: unsafe ?? undefined });
  }
  const name = /\b(?:please )?call me ([A-Z][a-z]{1,20})\b/.exec(text);
  if (name) out.push({ key: "pref:name", text: `Likes to be called ${name[1]}.`, convexOnly: "preferred name is an identifier; kept in Convex only" });
  return out;
}

// ---------------------------------------------------------------------------
// Sync: rebuild cues from canonical data and push the allowed ones to Moss.
// ---------------------------------------------------------------------------

export async function syncContinuity(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  /** The person's message this turn, for preference extraction. */
  text?: string;
  audit?: AuditLog;
  correlationId?: string;
}): Promise<ContinuitySyncResult> {
  const { memory, userId, consent } = opts;
  const moss = getPersonalMemoryProvider();
  if (!consent.wellnessMemory) {
    return { upserted: 0, removed: 0, convexOnly: 0, mossOk: true, backend: moss.backend, detail: "Memory consent off: nothing stored." };
  }
  const subject = mossSubject(userId);
  const t = now();

  // Latest cue per topic from recent canonical observations.
  const recent = (await activeObservations(memory)).filter((o) => t - o.createdAt <= TOPIC_WINDOW_MS);
  const desired = new Map<string, { cue: Cue | null; convexOnly?: string; sources: string[]; at: number }>();
  let convexOnlyNotes = 0;
  for (const o of recent) {
    const c = cueFor(o);
    if (!c) continue;
    if ("convexOnly" in c) {
      convexOnlyNotes++;
      continue; // stays in the canonical observation record only
    }
    const prev = desired.get(c.topic);
    if (!prev || o.createdAt >= prev.at) {
      desired.set(c.topic, { cue: c, sources: [...(prev?.sources ?? []), o.recordId], at: o.createdAt });
    } else {
      prev.sources.push(o.recordId);
    }
  }
  for (const p of opts.text ? extractPreferences(opts.text) : []) {
    desired.set(p.key, { cue: { topic: "preference", signal: "mentioned", text: p.text }, convexOnly: p.convexOnly, sources: [], at: t });
  }

  const existing = await ledger(memory);

  const toUpsert: MossDoc[] = [];
  const toRemove: string[] = [];
  const writes: { rec?: ContinuityRecord; data: Omit<ContinuityRecord, "recordId"> }[] = [];

  for (const [key, want] of desired) {
    const docId = docIdFor(userId, key);
    const prev = existing.find((r) => (want.cue!.topic === "preference" ? r.docId === docId : r.topic === key));
    // A cue the person deleted stays gone until they raise the topic again.
    if (prev?.status === "deleted" && prev.deletedBy === "user" && want.at <= (prev.deletedAt ?? 0)) continue;
    const cue = want.cue!;
    const reason = want.convexOnly ?? unsafeForMoss(cue.text) ?? undefined;
    const sync: SyncState = reason ? "convex_only" : "synced";
    const unchanged = prev && prev.status === "active" && prev.text === cue.text && prev.sync === sync && prev.lastDiscussedAt >= want.at;
    if (unchanged) continue;
    const data: Omit<ContinuityRecord, "recordId"> = {
      docId,
      topic: cue.topic,
      signal: cue.signal,
      text: cue.text,
      sync,
      reason,
      sourceObservationIds: want.sources,
      status: "active",
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
      lastDiscussedAt: Math.max(want.at, prev?.lastDiscussedAt ?? 0),
    };
    writes.push({ rec: prev, data });
    if (sync === "synced") {
      toUpsert.push({ id: docId, text: cue.text, metadata: { subject, topic: cue.topic, signal: cue.signal, kind: "sahaya-wellness-continuity" } });
    } else if (prev?.sync === "synced") {
      toRemove.push(docId);
    }
  }

  // Topic cues whose source observations were all deleted/corrected away.
  for (const r of existing) {
    if (r.status !== "active" || r.topic === "preference") continue;
    if (!desired.has(r.topic) && r.sourceObservationIds.length) {
      writes.push({ rec: r, data: { ...r, status: "deleted", deletedAt: t, deletedBy: "system", updatedAt: t } });
      if (r.sync === "synced") toRemove.push(r.docId);
    }
  }

  let mossOk = true;
  let detail = "";
  try {
    await moss.upsert(toUpsert);
    await moss.remove(toRemove);
    detail = `${toUpsert.length} cue(s) upserted, ${toRemove.length} removed in ${moss.backend === "moss" ? "Moss" : "Moss sandbox"}.`;
  } catch (err) {
    mossOk = false;
    detail = `Moss sync failed (${err instanceof Error ? err.message : String(err)}); Convex ledger still updated.`;
  }

  // Convex ledger is written regardless: it is the canonical record.
  for (const w of writes) {
    const data = { ...w.data, sync: w.data.sync === "synced" && !mossOk ? ("failed" as const) : w.data.sync };
    if (w.rec) await memory.update(w.rec.recordId, data as unknown as Record<string, unknown>);
    else await memory.save(COLLECTION, data as unknown as Record<string, unknown>, { tags: ["continuity", data.topic] });
  }
  const convexOnly = writes.filter((w) => w.data.sync === "convex_only").length + convexOnlyNotes;

  await opts.audit?.record({
    actor: "wellness",
    action: "continuity.sync",
    correlationId: opts.correlationId,
    detail: { upserted: toUpsert.length, removed: toRemove.length, convexOnly, mossOk, backend: moss.backend },
  });
  return { upserted: mossOk ? toUpsert.length : 0, removed: mossOk ? toRemove.length : 0, convexOnly, mossOk, backend: moss.backend, detail };
}

// ---------------------------------------------------------------------------
// Retrieval.
// ---------------------------------------------------------------------------

/** Tie-breaker: what a caring check-in would ask about first. */
const TOPIC_PRIORITY: Record<ContinuityTopic, number> = { sleep: 0.3, mood: 0.25, social: 0.2, energy: 0.15, activity: 0.1, preference: 0 };

function relevance(r: ContinuityRecord, query: string | undefined, t: number): number {
  const ageDays = (t - r.lastDiscussedAt) / 86_400_000;
  let score = 1 / (1 + ageDays); // recency
  if (r.signal === "poor" || r.signal === "low" || r.signal === "tired") score += 0.5; // worth checking in on
  score += TOPIC_PRIORITY[r.topic];
  if (query) {
    const q = query.toLowerCase();
    if (q.includes(r.topic)) score += 1;
    for (const w of r.text.toLowerCase().split(/\W+/)) if (w.length > 3 && q.includes(w)) score += 0.3;
  }
  return score;
}

export async function retrieveContinuity(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  query?: string;
  limit?: number;
  audit?: AuditLog;
}): Promise<RetrievedContinuity> {
  const { memory, userId, consent } = opts;
  if (!consent.wellnessMemory) return { items: [], source: "none", dropped: 0, detail: "Memory consent off: nothing retrieved." };

  const active = (await ledger(memory)).filter((r) => r.status === "active");
  if (!active.length) return { items: [], source: "none", dropped: 0, detail: "No continuity memories yet." };

  // "failed" records are meant to be in Moss too (the next sync retries them).
  const synced = active.filter((r) => r.sync === "synced" || r.sync === "failed");
  const subject = mossSubject(userId);
  let source: RetrievedContinuity["source"] = synced.length ? "moss" : "convex";
  let dropped = 0;
  let detail = "";
  const verified = new Set<string>();
  const rejected = new Set<string>();

  if (synced.length) {
    try {
      const docs = await getPersonalMemoryProvider().get(synced.map((r) => r.docId));
      const byId = new Map(synced.map((r) => [r.docId, r]));
      for (const d of docs) {
        const rec = byId.get(d.id);
        const ok = rec && d.metadata?.subject === subject && d.text === rec.text && !unsafeForMoss(d.text);
        if (ok) verified.add(d.id);
        else {
          rejected.add(d.id);
          dropped++;
        }
      }
      detail = `${verified.size} memory(ies) retrieved from Moss and verified against the Convex ledger.`;
    } catch (err) {
      source = "convex_fallback";
      detail = `Moss unavailable (${err instanceof Error ? err.message : String(err)}); served from the Convex ledger.`;
    }
  }

  // A doc that failed verification is excluded outright. A synced record Moss
  // didn't return (async build still running) falls back to the canonical copy.
  const items = active.filter((r) => !rejected.has(r.docId));
  const t = now();
  items.sort((a, b) => relevance(b, opts.query, t) - relevance(a, opts.query, t));
  if (dropped) {
    await opts.audit?.record({ actor: "wellness", action: "continuity.dropped", detail: { dropped } });
  }
  return { items: items.slice(0, opts.limit ?? 5), source, dropped, detail: detail || "Served from the Convex ledger." };
}

/** All active continuity records (Convex), for the person's review screen. */
export async function listContinuity(memory: ScopedMemory): Promise<ContinuityRecord[]> {
  return (await ledger(memory)).filter((r) => r.status === "active").sort((a, b) => b.lastDiscussedAt - a.lastDiscussedAt);
}

/** The person asks Wellness to forget one continuity memory. */
export async function forgetContinuity(opts: { memory: ScopedMemory; recordId: string; audit?: AuditLog }): Promise<boolean> {
  const rec = await opts.memory.get(opts.recordId);
  if (!rec) return false;
  const r = fromRecord(rec);
  if (r.status !== "active") return false;
  const t = now();
  let mossOk = true;
  if (r.sync === "synced" || r.sync === "failed") {
    try {
      await getPersonalMemoryProvider().remove([r.docId]);
    } catch {
      mossOk = false;
    }
  }
  await opts.memory.update(r.recordId, { ...r, status: "deleted", deletedAt: t, deletedBy: "user", updatedAt: t } as unknown as Record<string, unknown>);
  await opts.audit?.record({ actor: "wellness", action: "continuity.forget", detail: { recordId: r.recordId, topic: r.topic, mossOk } });
  return true;
}

/** Consent withdrawn or "forget everything": remove every cue from Moss and Convex. */
export async function purgeContinuity(opts: { memory: ScopedMemory; audit?: AuditLog }): Promise<number> {
  const active = (await ledger(opts.memory)).filter((r) => r.status === "active");
  let n = 0;
  for (const r of active) if (await forgetContinuity({ memory: opts.memory, recordId: r.recordId })) n++;
  await opts.audit?.record({ actor: "wellness", action: "continuity.purge", detail: { removed: n } });
  return n;
}
