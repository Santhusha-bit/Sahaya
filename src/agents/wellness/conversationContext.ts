/**
 * Long-term conversational context (Backboard track).
 *
 * Flow:
 *   1. In conversation, Margaret mentions a hobby or a family visit. A deterministic
 *      screen extracts ONLY permitted life-context facts (no health data, no
 *      instructions, PII redacted) and writes them to Convex (the canonical
 *      `conversationContext` collection in Wellness scoped memory).
 *   2. The minimized fact is indexed in Backboard (per-user assistant space) with a
 *      pointer back to its Convex record.
 *   3. Days later, Wellness queries Backboard with what she is saying now.
 *   4. Every hit is re-verified in code against the Convex record: it must map to a
 *      record this user owns, still be active, match the current version and
 *      content, carry sane source timestamps, be within the retention window, and
 *      consent must still be granted right now. Backboard text is never used
 *      directly; the canonical Convex text is.
 *   5. The verified facts let Wellness pick the thread back up naturally.
 *   6. She can review, correct, or forget anything; Backboard is updated to match,
 *      and a failed Backboard update can never resurface stale text (step 4).
 */

import { now as clock } from "@/lib/id";
import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { MemoryRecord, ScopedMemory } from "@/agents/base/types";
import { getConversationMemoryProvider, userTag, type ConversationMemoryProvider } from "@/integrations/backboard";
import { DIAGNOSIS_TERMS, INJECTION_TERMS, MEDICATION_TERMS } from "./observationPolicy";
import { minimizeForExternal } from "./privacyFilter";

const COLLECTION = "conversationContext";
const LINK_COLLECTION = "backboardLink";
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_CONTEXT_AGE_DAYS = 180;
const MAX_FACT_CHARS = 200;

export type ContextCategory = "hobby" | "family_visit";
const PERMITTED_CATEGORIES: ReadonlySet<string> = new Set<ContextCategory>(["hobby", "family_visit"]);

export interface ContextRecord {
  recordId: string;
  category: ContextCategory;
  topic: string;
  fact: string;
  status: "active" | "deleted";
  version: number;
  /** When the person said it. Immutable. */
  sourceAt: number;
  createdAt: number;
  updatedAt: number;
  correctedAt?: number;
  deletedAt?: number;
  history?: { fact: string; at: number }[];
  backboard?: {
    memoryId: string | null;
    syncedVersion: number;
    syncedAt: number;
    pendingResync?: boolean;
    lastError?: string;
  };
}

export interface RecalledContext {
  recordId: string;
  category: ContextCategory;
  topic: string;
  /** Canonical Convex text, never the Backboard copy. */
  fact: string;
  sourceAt: number;
  ageDays: number;
  score: number;
}

export type RecallRejection =
  | "no_canonical_record"
  | "wrong_user"
  | "deleted"
  | "stale_version"
  | "stale_timestamp"
  | "timestamp_invalid"
  | "expired"
  | "category_not_permitted";

export interface RecallResult {
  recalled: RecalledContext[];
  rejected: { memoryId: string; reason: RecallRejection }[];
  blocked?: "consent";
  mode: "live" | "sandbox";
  ok: boolean;
  detail: string;
}

/** Both the general memory switch and the conversational-context switch must be on. */
export function contextAllowed(consent: ConsentSettings): boolean {
  return consent.wellnessMemory !== false && consent.wellnessConversationMemory !== false;
}

// ---------------------------------------------------------------------------
// Extraction: deterministic, evidence-is-the-sentence-itself.
// ---------------------------------------------------------------------------

const HOBBIES: { topic: string; re: RegExp }[] = [
  { topic: "gardening", re: /\b(garden|gardening|roses|tomatoes|planting|seedlings|allotment)\b/ },
  { topic: "knitting", re: /\b(knit|knitting|crochet|crocheting|quilt|quilting|sewing)\b/ },
  { topic: "painting", re: /\b(paint|painting|watercolou?rs?|sketching|drawing)\b/ },
  { topic: "baking", re: /\b(bake|baking|baked|cookies|pies?|scones)\b/ },
  { topic: "reading", re: /\b(reading|book club|novels?|mysteries)\b/ },
  { topic: "puzzles", re: /\b(crosswords?|jigsaw|puzzles?|sudoku)\b/ },
  { topic: "birdwatching", re: /\b(bird ?watching|birds?|bird feeder)\b/ },
  { topic: "cards", re: /\b(bridge club|bridge|canasta|card games?|chess)\b/ },
  { topic: "music", re: /\b(choir|singing|piano|violin|guitar)\b/ },
  { topic: "walking", re: /\b(walks|walking|hiking)\b/ },
  { topic: "swimming", re: /\b(swim|swimming)\b/ },
  { topic: "fishing", re: /\b(fishing)\b/ },
  { topic: "golf", re: /\b(golf)\b/ },
  { topic: "dancing", re: /\b(dancing|ballroom)\b/ },
  { topic: "photography", re: /\b(photography|photos)\b/ },
  { topic: "woodworking", re: /\b(woodworking|carving)\b/ },
];
const HOBBY_CUE = /\b(love|loved|enjoy|enjoyed|like|liked|been|started|took up|taking up|my|spent|working on|doing|did|went|go to|joined|favou?rite|growing|grew|planted|finished|made)\b/;

const RELATION = /\b(daughter|son|grandson|granddaughter|grandchildren|grandkids|grandchild|sister|brother|niece|nephew|family)\b/;
const VISIT = /\b(visit|visiting|visited|came over|coming over|come over|coming to see|came to see|staying with|stay with|coming for|came for|is coming|are coming|will come|drove up|driving up|flying in|fly in)\b/;

export interface ContextFact {
  category: ContextCategory;
  topic: string;
  fact: string;
}

export interface ContextExtraction {
  facts: ContextFact[];
  /** Reasons only; rejected text is never stored. */
  rejected: { reason: "injection" | "health" | "too_long" }[];
}

function screenSentence(sentence: string): { ok: true; text: string } | { ok: false; reason: "injection" | "health" | "too_long" } {
  const low = sentence.toLowerCase();
  if (INJECTION_TERMS.some((t) => low.includes(t))) return { ok: false, reason: "injection" };
  // Health facts belong in the canonical observation pipeline, not in a
  // conversational index; never duplicate them into Backboard.
  if ([...DIAGNOSIS_TERMS, ...MEDICATION_TERMS].some((t) => low.includes(t))) return { ok: false, reason: "health" };
  const minimized = minimizeForExternal(sentence, { maxChars: 1000 }).text.replace(/^(and|but|also|oh|well|so)[,\s]+/i, "").trim();
  if (minimized.length > MAX_FACT_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text: minimized };
}

export function extractConversationContext(text: string): ContextExtraction {
  const facts: ContextFact[] = [];
  const rejected: ContextExtraction["rejected"] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const low = sentence.toLowerCase();
    let candidate: Omit<ContextFact, "fact"> | null = null;
    const rel = low.match(RELATION);
    if (rel && VISIT.test(low)) {
      candidate = { category: "family_visit", topic: `${rel[1]} visit` };
    } else if (HOBBY_CUE.test(low)) {
      const hobby = HOBBIES.find((h) => h.re.test(low));
      if (hobby) candidate = { category: "hobby", topic: hobby.topic };
    }
    if (!candidate) continue;
    const screened = screenSentence(sentence);
    if (!screened.ok) {
      rejected.push({ reason: screened.reason });
      continue;
    }
    facts.push({ ...candidate, fact: screened.text });
  }
  return { facts, rejected };
}

/** A recall-style question ("do you remember...") rather than new information. */
export function isRecallQuestion(text: string): boolean {
  return /\b(remember|did i (tell|mention)|what did i (say|tell)|last time we|i told you)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Canonical store (Convex scoped memory).
// ---------------------------------------------------------------------------

function fromRecord(rec: MemoryRecord): ContextRecord {
  return { ...(rec.data as unknown as ContextRecord), recordId: rec.id };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

async function allContextRecords(memory: ScopedMemory): Promise<ContextRecord[]> {
  return (await memory.list(COLLECTION)).map(fromRecord);
}

/** What Wellness remembers, for the person's review. Deleted items are hidden. */
export async function listRememberedContext(memory: ScopedMemory): Promise<(ContextRecord & { syncState: "synced" | "pending" | "local_only" })[]> {
  return (await allContextRecords(memory))
    .filter((r) => r.status === "active")
    .sort((a, b) => b.sourceAt - a.sourceAt)
    .map((r) => ({
      ...r,
      syncState: !r.backboard
        ? "local_only"
        : r.backboard.pendingResync || r.backboard.syncedVersion !== r.version
          ? "pending"
          : "synced",
    }));
}

async function findSpace(memory: ScopedMemory, provider: ConversationMemoryProvider): Promise<string | null> {
  const rows = await memory.list(LINK_COLLECTION);
  const row = rows.find((r) => (r.data as { backend?: string }).backend === provider.backend);
  return row ? String((row.data as { spaceId: string }).spaceId) : null;
}

async function ensureSpace(memory: ScopedMemory, provider: ConversationMemoryProvider, userId: string): Promise<string> {
  const existing = await findSpace(memory, provider);
  if (existing) return existing;
  const spaceId = await provider.createSpace(userTag(userId));
  await memory.save(LINK_COLLECTION, { backend: provider.backend, spaceId, createdAt: clock() }, { tags: ["backboard"] });
  return spaceId;
}

/** Push one record's CURRENT canonical version to Backboard (replace-on-change). */
async function syncRecord(memory: ScopedMemory, provider: ConversationMemoryProvider, userId: string, rec: ContextRecord, at: number): Promise<void> {
  try {
    const spaceId = await ensureSpace(memory, provider, userId);
    if (rec.backboard?.memoryId) await provider.remove(spaceId, rec.backboard.memoryId);
    const { memoryId } = await provider.add(spaceId, {
      content: rec.fact,
      metadata: {
        kinline_record_id: rec.recordId,
        user_tag: userTag(userId),
        category: rec.category,
        topic: rec.topic,
        version: rec.version,
        source_at: rec.sourceAt,
        source_updated_at: rec.updatedAt,
      },
    });
    await memory.update(rec.recordId, { backboard: { memoryId, syncedVersion: rec.version, syncedAt: at } });
  } catch (err) {
    await memory.update(rec.recordId, {
      backboard: {
        memoryId: rec.backboard?.memoryId ?? null,
        syncedVersion: rec.backboard?.syncedVersion ?? 0,
        syncedAt: rec.backboard?.syncedAt ?? 0,
        pendingResync: true,
        lastError: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

export interface SaveContextResult {
  saved: ContextRecord[];
  duplicates: number;
  rejected: ContextExtraction["rejected"];
  blocked?: "consent";
  sync: { mode: "live" | "sandbox"; ok: boolean; detail: string } | null;
}

/** Extract permitted context from what the person said, store canonically, index in Backboard. */
export async function saveConversationContext(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  text: string;
  audit?: AuditLog;
  correlationId?: string;
  now?: number;
}): Promise<SaveContextResult> {
  if (!contextAllowed(opts.consent)) return { saved: [], duplicates: 0, rejected: [], blocked: "consent", sync: null };
  const at = opts.now ?? clock();
  const { facts, rejected } = extractConversationContext(opts.text);
  const provider = getConversationMemoryProvider();
  const mode: "live" | "sandbox" = provider.backend === "backboard" ? "live" : "sandbox";

  const active =(await allContextRecords(opts.memory)).filter((r) => r.status === "active");
  const saved: ContextRecord[] = [];
  let duplicates = 0;
  for (const f of facts) {
    if (active.some((r) => r.category === f.category && norm(r.fact) === norm(f.fact))) {
      duplicates++;
      continue;
    }
    const data: Omit<ContextRecord, "recordId"> = { ...f, status: "active", version: 1, sourceAt: at, createdAt: at, updatedAt: at };
    const rec = await opts.memory.save(COLLECTION, data as unknown as Record<string, unknown>, { tags: ["context", f.category] });
    saved.push({ ...data, recordId: rec.id });
  }

  let failures = 0;
  let lastError = "";
  for (const rec of saved) {
    try {
      await syncRecord(opts.memory, provider, opts.userId, rec, at);
    } catch (err) {
      failures++;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  await opts.audit?.record({
    actor: "wellness",
    action: "context.save",
    correlationId: opts.correlationId,
    detail: { saved: saved.length, duplicates, rejected: rejected.map((r) => r.reason), categories: saved.map((r) => r.category), backboard: { mode, failures } },
  });

  const sync: SaveContextResult["sync"] = !saved.length
    ? { mode, ok: true, detail: "No new conversational context to index." }
    : failures
      ? { mode, ok: false, detail: `Backboard indexing failed for ${failures}/${saved.length} fact(s) (${lastError}); Convex record kept, marked for resync.` }
      : { mode, ok: true, detail: `${saved.length} context fact(s) indexed in Backboard.` };
  return { saved, duplicates, rejected, sync };
}

// ---------------------------------------------------------------------------
// Verified recall.
// ---------------------------------------------------------------------------

export async function recallConversationContext(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  query: string;
  limit?: number;
  audit?: AuditLog;
  correlationId?: string;
  now?: number;
}): Promise<RecallResult> {
  const provider = getConversationMemoryProvider();
  const mode = provider.backend === "backboard" ? "live" : "sandbox";
  // Permission is checked at retrieval time, not just at save time.
  if (!contextAllowed(opts.consent)) {
    return { recalled: [], rejected: [], blocked: "consent", mode, ok: true, detail: "Conversational memory is turned off; Backboard was not queried." };
  }
  const at = opts.now ?? clock();
  const limit = opts.limit ?? 3;
  const spaceId = await findSpace(opts.memory, provider);
  if (!spaceId) return { recalled: [], rejected: [], mode, ok: true, detail: "Nothing remembered yet." };

  const hits = await provider.search(spaceId, opts.query, limit * 3);
  const records = await allContextRecords(opts.memory);
  const byMemoryId = new Map(records.filter((r) => r.backboard?.memoryId).map((r) => [r.backboard!.memoryId!, r]));
  const tag = userTag(opts.userId);

  const recalled: RecalledContext[] = [];
  const rejected: RecallResult["rejected"] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const pointer = typeof hit.metadata.kinline_record_id === "string" ? hit.metadata.kinline_record_id : null;
    // Map to the canonical record. A metadata pointer is honoured only for a record
    // in THIS user's scoped memory whose write never returned a Backboard id.
    const rec = byMemoryId.get(hit.memoryId)
      ?? (pointer ? records.find((r) => r.recordId === pointer && !r.backboard?.memoryId) : undefined);
    const reject = (reason: RecallRejection) => rejected.push({ memoryId: hit.memoryId, reason });

    if (!rec) { reject("no_canonical_record"); continue; }
    if (hit.metadata.user_tag !== undefined && hit.metadata.user_tag !== tag) { reject("wrong_user"); continue; }
    if (rec.status !== "active") {
      reject("deleted");
      if (hit.memoryId) await provider.remove(spaceId, hit.memoryId).catch(() => false);
      continue;
    }
    if (!PERMITTED_CATEGORIES.has(rec.category)) { reject("category_not_permitted"); continue; }
    if (rec.backboard?.syncedVersion !== rec.version || norm(hit.content) !== norm(rec.fact)) {
      reject("stale_version");
      await opts.memory.update(rec.recordId, { backboard: { ...(rec.backboard ?? { memoryId: null, syncedVersion: 0, syncedAt: 0 }), pendingResync: true } });
      continue;
    }
    if (hit.metadata.source_updated_at !== undefined && Number(hit.metadata.source_updated_at) !== rec.updatedAt) { reject("stale_timestamp"); continue; }
    if (rec.sourceAt > at + CLOCK_SKEW_MS || rec.updatedAt < rec.sourceAt || rec.createdAt !== rec.sourceAt) { reject("timestamp_invalid"); continue; }
    if (at - rec.sourceAt > MAX_CONTEXT_AGE_DAYS * DAY_MS) { reject("expired"); continue; }
    if (seen.has(rec.recordId)) continue;
    seen.add(rec.recordId);
    recalled.push({
      recordId: rec.recordId,
      category: rec.category,
      topic: rec.topic,
      fact: rec.fact,
      sourceAt: rec.sourceAt,
      ageDays: Math.floor((at - rec.sourceAt) / DAY_MS),
      score: hit.score,
    });
    if (recalled.length >= limit) break;
  }

  await opts.audit?.record({
    actor: "wellness",
    action: "context.recall",
    correlationId: opts.correlationId,
    detail: { mode, hits: hits.length, recalled: recalled.map((r) => r.recordId), rejected: rejected.map((r) => r.reason) },
  });
  return {
    recalled,
    rejected,
    mode,
    ok: true,
    detail: `${recalled.length} verified context fact(s) recalled${rejected.length ? `; ${rejected.length} Backboard hit(s) rejected (${[...new Set(rejected.map((r) => r.reason))].join(", ")})` : ""}.`,
  };
}

// ---------------------------------------------------------------------------
// Review / correct / forget.
// ---------------------------------------------------------------------------

export async function correctRememberedContext(opts: {
  memory: ScopedMemory;
  userId: string;
  recordId: string;
  fact: string;
  audit?: AuditLog;
  correlationId?: string;
  now?: number;
}): Promise<{ ok: true; record: ContextRecord; synced: boolean } | { ok: false; error: "not_found" | "injection" | "health" | "too_long" }> {
  const raw = await opts.memory.get(opts.recordId);
  if (!raw || raw.collection !== COLLECTION) return { ok: false, error: "not_found" };
  const cur = fromRecord(raw);
  if (cur.status !== "active") return { ok: false, error: "not_found" };
  const screened = screenSentence(opts.fact.trim());
  if (!screened.ok) return { ok: false, error: screened.reason };

  const at = opts.now ?? clock();
  // Re-derive the topic from the corrected words ("daughter" -> "granddaughter").
  const reclassified = extractConversationContext(screened.text).facts[0];
  const next: Partial<ContextRecord> = {
    fact: screened.text,
    ...(reclassified ? { category: reclassified.category, topic: reclassified.topic } : {}),
    version: cur.version + 1,
    updatedAt: Math.max(at, cur.updatedAt),
    correctedAt: at,
    history: [...(cur.history ?? []), { fact: cur.fact, at: cur.updatedAt }],
  };
  const updated = await opts.memory.update(opts.recordId, next as Record<string, unknown>);
  if (!updated) return { ok: false, error: "not_found" };
  const rec = fromRecord(updated);

  let synced = true;
  try {
    await syncRecord(opts.memory, getConversationMemoryProvider(), opts.userId, rec, at);
  } catch {
    synced = false; // recall rejects the stale Backboard copy until resync succeeds
  }
  await opts.audit?.record({
    actor: "wellness",
    action: "context.correct",
    correlationId: opts.correlationId,
    detail: { recordId: opts.recordId, newVersion: rec.version, backboardSynced: synced },
  });
  const final = await opts.memory.get(opts.recordId);
  return { ok: true, record: final ? fromRecord(final) : rec, synced };
}

export async function forgetRememberedContext(opts: {
  memory: ScopedMemory;
  recordId: string;
  audit?: AuditLog;
  correlationId?: string;
  now?: number;
}): Promise<{ ok: boolean; removedFromBackboard: boolean }> {
  const raw = await opts.memory.get(opts.recordId);
  if (!raw || raw.collection !== COLLECTION) return { ok: false, removedFromBackboard: false };
  const cur = fromRecord(raw);
  const provider = getConversationMemoryProvider();
  let removedFromBackboard = false;
  const spaceId = await findSpace(opts.memory, provider);
  if (spaceId && cur.backboard?.memoryId) {
    removedFromBackboard = await provider.remove(spaceId, cur.backboard.memoryId).catch(() => false);
  }
  // Tombstone without content: forgetting erases the words, keeps the audit trail.
  await opts.memory.update(opts.recordId, { status: "deleted", deletedAt: opts.now ?? clock(), fact: "", history: [] });
  await opts.audit?.record({
    actor: "wellness",
    action: "context.forget",
    correlationId: opts.correlationId,
    detail: { recordId: opts.recordId, removedFromBackboard },
  });
  return { ok: true, removedFromBackboard };
}

/** Retry any record whose Backboard copy is missing or behind the canonical version. */
export async function resyncConversationContext(memory: ScopedMemory, userId: string, at = clock()): Promise<{ attempted: number; ok: number }> {
  const provider = getConversationMemoryProvider();
  const pending = (await allContextRecords(memory)).filter(
    (r) => r.status === "active" && (!r.backboard || r.backboard.pendingResync || r.backboard.syncedVersion !== r.version),
  );
  let ok = 0;
  for (const rec of pending) {
    try {
      await syncRecord(memory, provider, userId, rec, at);
      ok++;
    } catch {
      /* stays pending */
    }
  }
  return { attempted: pending.length, ok };
}

// ---------------------------------------------------------------------------
// Natural continuation.
// ---------------------------------------------------------------------------

export function whenSaid(ageDays: number): string {
  if (ageDays <= 0) return "earlier today";
  if (ageDays === 1) return "yesterday";
  if (ageDays < 14) return `${ageDays} days ago`;
  return `a few weeks ago`;
}

/** Warm continuation grounded in a verified fact. The fact is quoted as her own words, never executed. */
export function continueFromContext(recalled: RecalledContext[]): string | null {
  const top = recalled[0];
  if (!top) return null;
  const quote = top.fact.replace(/[.!?]+$/, "");
  const when = whenSaid(top.ageDays);
  if (top.category === "family_visit") {
    const who = top.topic.replace(/ visit$/, "");
    return `I remember: ${when} you told me, "${quote}." How was the time with your ${who}?`;
  }
  return `I remember: ${when} you told me, "${quote}." How has the ${top.topic} been going?`;
}
