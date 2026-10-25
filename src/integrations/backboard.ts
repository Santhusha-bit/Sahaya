/**
 * Backboard: long-term conversational context index for Wellness.
 *
 * Responsibility split (so nothing sensitive is stored twice):
 *   - Convex (Wellness scoped memory) is the SOURCE OF TRUTH for every remembered
 *     fact: its text, status, version, timestamps and correction history.
 *   - Moss holds short continuity notes derived from accepted wellness
 *     observations (mood / social), i.e. "how she has been".
 *   - Backboard holds ONLY minimized life-context facts the person chose to share
 *     in conversation (hobbies, family visits, plans), i.e. "what she talks about",
 *     so Wellness can pick a thread back up days later. No raw transcripts, no
 *     health observations, no identifiers beyond a pseudonymous user tag.
 *
 * Backboard is treated as an untrusted semantic index: every hit it returns is
 * re-verified against the Convex record before use (see conversationContext.ts).
 *
 * Live API (docs.backboard.io): base https://app.backboard.io/api, header
 * `X-API-Key`. Memories are scoped to an assistant, so each Sahaya user gets their
 * OWN Backboard assistant ("space"); the space id is stored in that user's scoped
 * Convex memory, which makes cross-user retrieval impossible by construction.
 *   POST   /assistants                                  { name, system_prompt } -> { assistant_id }
 *   POST   /assistants/{id}/memories                    { content, metadata }   -> { memory_id }
 *   POST   /assistants/{id}/memories/search             { query, limit }        -> { memories: [{ id, content, score, metadata }] }
 *   DELETE /assistants/{id}/memories/{memory_id}
 * Without BACKBOARD_API_KEY an in-process sandbox implements the same interface.
 */

import { createHash } from "node:crypto";
import { id, now } from "@/lib/id";
import { backboardStatus } from "@/lib/env";

export interface RemoteMemoryHit {
  memoryId: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface ConversationMemoryProvider {
  readonly backend: "backboard" | "sandbox";
  /** Create the per-user memory space (a Backboard assistant). */
  createSpace(userTag: string): Promise<string>;
  add(spaceId: string, item: { content: string; metadata: Record<string, unknown> }): Promise<{ memoryId: string | null }>;
  search(spaceId: string, query: string, limit: number): Promise<RemoteMemoryHit[]>;
  remove(spaceId: string, memoryId: string): Promise<boolean>;
}

/** Pseudonymous tag for a Sahaya user: the raw user id never leaves Sahaya. */
export function userTag(userId: string): string {
  return createHash("sha256").update(`sahaya-wellness:${userId}`).digest("hex").slice(0, 16);
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it", "me", "my", "i", "you", "your", "been", "have", "had", "about", "last", "this", "that", "what", "remember", "told", "tell", "did", "was", "were", "how"]);

/** Light stemming so "garden" matches "gardening" and "visited" matches "visit". */
function stem(t: string): string {
  return t.replace(/(ing|ers|er|ed|es|s)$/, "");
}
export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)).map(stem);
}

export class SandboxConversationMemory implements ConversationMemoryProvider {
  readonly backend = "sandbox" as const;
  private spaces = new Map<string, { memoryId: string; content: string; metadata: Record<string, unknown>; at: number }[]>();

  async createSpace(_userTag: string): Promise<string> {
    const spaceId = id("bbspace");
    this.spaces.set(spaceId, []);
    return spaceId;
  }
  async add(spaceId: string, item: { content: string; metadata: Record<string, unknown> }): Promise<{ memoryId: string | null }> {
    // A space id persisted in Convex can outlive this in-process store (server restart).
    if (!this.spaces.has(spaceId)) this.spaces.set(spaceId, []);
    const rows = this.spaces.get(spaceId)!;
    const memoryId = id("bbmem");
    rows.push({ memoryId, content: item.content, metadata: { ...item.metadata }, at: now() });
    return { memoryId };
  }
  async search(spaceId: string, query: string, limit: number): Promise<RemoteMemoryHit[]> {
    const rows = this.spaces.get(spaceId) ?? [];
    const terms = tokenize(query);
    const hits: RemoteMemoryHit[] = [];
    for (const r of rows) {
      const hay = new Set(tokenize(`${String(r.metadata.topic ?? "")} ${r.content}`));
      const overlap = terms.filter((t) => hay.has(t)).length;
      if (!terms.length || overlap === 0) continue;
      hits.push({ memoryId: r.memoryId, content: r.content, score: overlap / terms.length, metadata: { ...r.metadata } });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
  async remove(spaceId: string, memoryId: string): Promise<boolean> {
    const rows = this.spaces.get(spaceId);
    if (!rows) return false;
    const i = rows.findIndex((r) => r.memoryId === memoryId);
    if (i < 0) return false;
    rows.splice(i, 1);
    return true;
  }

  /** Test hook: tamper with a stored memory to prove retrieval re-verifies against Convex. */
  _tamper(spaceId: string, memoryId: string, content: string): void {
    const row = this.spaces.get(spaceId)?.find((r) => r.memoryId === memoryId);
    if (row) row.content = content;
  }
  /** Test hook: inject an arbitrary hit (e.g. one pointing at another user's record). */
  _inject(spaceId: string, content: string, metadata: Record<string, unknown>): string {
    const memoryId = id("bbmem");
    this.spaces.get(spaceId)?.push({ memoryId, content, metadata, at: now() });
    return memoryId;
  }
}

/** Live Backboard adapter (plain fetch, no SDK). Used only with BACKBOARD_API_KEY. */
export class BackboardConversationMemory implements ConversationMemoryProvider {
  readonly backend = "backboard" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = process.env.BACKBOARD_BASE_URL?.trim() || "https://app.backboard.io/api",
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  }

  async createSpace(tag: string): Promise<string> {
    const res = await this.req("/assistants", {
      method: "POST",
      body: JSON.stringify({
        name: `sahaya-wellness-${tag}`,
        system_prompt: "Long-term conversational context index for one Sahaya Wellness user. Stores short, consented life-context facts only.",
      }),
    });
    if (!res.ok) throw new Error(`Backboard create assistant failed: ${res.status}`);
    const data = (await res.json()) as { assistant_id?: string };
    if (!data.assistant_id) throw new Error("Backboard create assistant returned no assistant_id");
    return data.assistant_id;
  }

  async add(spaceId: string, item: { content: string; metadata: Record<string, unknown> }): Promise<{ memoryId: string | null }> {
    const res = await this.req(`/assistants/${encodeURIComponent(spaceId)}/memories`, {
      method: "POST",
      body: JSON.stringify({ content: item.content, metadata: item.metadata }),
    });
    if (!res.ok) throw new Error(`Backboard add memory failed: ${res.status}`);
    const data = (await res.json()) as { memory_id?: string; id?: string };
    // Memory writes may be asynchronous; a missing id is tolerated and the record
    // is matched later by its metadata pointer + exact content.
    return { memoryId: data.memory_id ?? data.id ?? null };
  }

  async search(spaceId: string, query: string, limit: number): Promise<RemoteMemoryHit[]> {
    const res = await this.req(`/assistants/${encodeURIComponent(spaceId)}/memories/search`, {
      method: "POST",
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) throw new Error(`Backboard search failed: ${res.status}`);
    const data = (await res.json()) as { memories?: { id?: string; memory_id?: string; content?: string; score?: number; metadata?: Record<string, unknown> }[] };
    return (data.memories ?? [])
      .filter((m) => typeof m.content === "string")
      .map((m) => ({
        memoryId: m.id ?? m.memory_id ?? "",
        content: m.content as string,
        score: typeof m.score === "number" ? m.score : 0,
        metadata: m.metadata ?? {},
      }));
  }

  async remove(spaceId: string, memoryId: string): Promise<boolean> {
    const res = await this.req(`/assistants/${encodeURIComponent(spaceId)}/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  }
}

const GLOBAL_KEY = "__Sahaya_backboard__";

export function getConversationMemoryProvider(): ConversationMemoryProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as ConversationMemoryProvider;
  const provider = backboardStatus().mode === "live" && process.env.BACKBOARD_API_KEY
    ? new BackboardConversationMemory(process.env.BACKBOARD_API_KEY)
    : new SandboxConversationMemory();
  g[GLOBAL_KEY] = provider;
  return provider;
}
export function setConversationMemoryProvider(p: ConversationMemoryProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetConversationMemoryProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
