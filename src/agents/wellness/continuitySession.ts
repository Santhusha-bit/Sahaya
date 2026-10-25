/**
 * Wellness conversation sessions with continuity.
 *
 * openWellnessSession: retrieves what Wellness remembers (Moss, verified against
 * the Convex ledger) and composes a contextual, non-diagnostic opener, so a
 * returning person is asked about what they shared last time instead of being
 * greeted with the same introductory questions.
 *
 * endWellnessSession: makes sure the continuity cues for everything discussed are
 * synced, and writes a minimized session summary to Convex (`conversationLog`).
 *
 * The opener is built from the ledger's structured topic/signal fields, never by
 * echoing retrieved text, so stored memory can't inject words into the reply.
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import { id, now } from "@/lib/id";
import { retrieveContinuity, syncContinuity, type ContinuityRecord, type RetrievedContinuity } from "./continuityMemory";

export const FIRST_TIME_GREETING =
  "Hi, I'm Wellness. I'm here to talk and to listen, about your day, how you're feeling, whatever's on your mind. How are you today?";

const SESSIONS = "conversationLog";

export interface OpenedSession {
  sessionId: string;
  greeting: string;
  returning: boolean;
  /** Which memory shaped the opener (null for a first-time greeting). */
  basedOn: { recordId: string; topic: string; signal: string } | null;
  memories: ContinuityRecord[];
  retrieval: Pick<RetrievedContinuity, "source" | "dropped" | "detail">;
}

function openerFor(r: ContinuityRecord): string | null {
  const key = `${r.topic}:${r.signal}`;
  switch (key) {
    case "sleep:poor":
      return "Welcome back. Last time we talked, you mentioned you hadn't been sleeping well. How have you been sleeping since then?";
    case "sleep:good":
      return "Welcome back. Last time you said you'd been sleeping well. Has that kept up?";
    case "sleep:mentioned":
      return "Welcome back. Last time we talked a little about your sleep. How have your nights been?";
    case "energy:tired":
      return "Welcome back. Last time you mentioned you'd been feeling tired. How has your energy been?";
    case "mood:low":
      return "Welcome back. Last time you said you'd been feeling a bit low. How are you feeling today?";
    case "social:low":
      return "Welcome back. Last time you mentioned feeling a bit lonely. Have you had some company since we spoke?";
    case "social:positive":
      return "Welcome back. Last time you told me about enjoying time with others. Have you seen anyone lately?";
    case "mood:positive":
      return "Welcome back. You were in good spirits last time we spoke. How has your day been?";
    case "energy:energetic":
    case "activity:mentioned":
      return "Welcome back. Last time you told me about keeping active. What have you been up to?";
    default:
      return null;
  }
}

/** "I remember you enjoy gardening" from a structured preference record. */
function preferenceTail(memories: ContinuityRecord[]): string {
  const pref = memories.find((m) => m.topic === "preference" && m.text.startsWith("Enjoys "));
  if (!pref) return "";
  const what = pref.text.replace(/^Enjoys /, "").replace(/\.$/, "");
  return /^[a-z][a-z ,'-]{1,48}$/.test(what) ? ` I hope you've had a chance to enjoy some ${what}, too.` : "";
}

export async function openWellnessSession(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  audit?: AuditLog;
}): Promise<OpenedSession> {
  const sessionId = id("wsess");
  const retrieved = await retrieveContinuity({ ...opts, limit: 5 });
  const memories = retrieved.items;

  let greeting = FIRST_TIME_GREETING;
  let basedOn: OpenedSession["basedOn"] = null;
  const lead = memories.find((m) => m.topic !== "preference" && openerFor(m));
  if (lead) {
    greeting = openerFor(lead)! + preferenceTail(memories);
    basedOn = { recordId: lead.recordId, topic: lead.topic, signal: lead.signal };
  } else if (memories.some((m) => m.topic === "preference")) {
    greeting = "Welcome back, it's lovely to talk again. How has your day been?" + preferenceTail(memories);
  }

  await opts.memory.save(SESSIONS, { kind: "session", sessionId, startedAt: now(), basedOn, memoriesUsed: memories.map((m) => m.recordId) }, { tags: ["session"] });
  await opts.audit?.record({
    actor: "wellness",
    action: "session.open",
    detail: { sessionId, returning: memories.length > 0, basedOn, source: retrieved.source, dropped: retrieved.dropped },
  });
  return {
    sessionId,
    greeting,
    returning: memories.length > 0,
    basedOn,
    memories,
    retrieval: { source: retrieved.source, dropped: retrieved.dropped, detail: retrieved.detail },
  };
}

export async function endWellnessSession(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  sessionId?: string;
  audit?: AuditLog;
}): Promise<{ sessionId: string | null; topics: string[]; sync: Awaited<ReturnType<typeof syncContinuity>> }> {
  type SessionRow = { recordId: string; kind?: string; sessionId?: string; startedAt?: number; endedAt?: number };
  const sessions = (await opts.memory.list(SESSIONS, { tag: "session" })).map((r) => ({ ...(r.data as Omit<SessionRow, "recordId">), recordId: r.id }) as SessionRow);
  const open = sessions
    .filter((s) => s.kind === "session" && !s.endedAt && (!opts.sessionId || s.sessionId === opts.sessionId))
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0];

  const sync = await syncContinuity({ memory: opts.memory, userId: opts.userId, consent: opts.consent, audit: opts.audit });
  const since = open ? Number(open.startedAt) : 0;
  const ledger = (await opts.memory.list("memoryRecords")).map((r) => r.data as unknown as ContinuityRecord);
  // Minimized summary: topic names only, never the conversation itself.
  const topics = [...new Set(ledger.filter((r) => r.status === "active" && r.lastDiscussedAt >= since).map((r) => r.topic))];

  if (open) {
    const { recordId, ...rest } = open;
    await opts.memory.update(recordId, { ...rest, endedAt: now(), topics });
  }
  await opts.audit?.record({ actor: "wellness", action: "session.end", detail: { sessionId: open?.sessionId ?? null, topics, mossOk: sync.mossOk } });
  return { sessionId: open?.sessionId ?? null, topics, sync };
}
