/**
 * Backboard — historical conversation context provider (Part 5, Track B, step 6).
 *
 * Backboard stores short, de-identified summaries of past conversations and
 * retrieves the ones most relevant to the current topic, so Wellness can say
 * "you mentioned this last week" with real grounding. Supplementary to Convex.
 *
 * Live with BACKBOARD_API_KEY; otherwise an in-process sandbox with the same
 * interface and a simple keyword relevance score (mirrors the incident search).
 * Every method is scoped to one userId.
 */

import { id, now } from "@/lib/id";
import { backboardStatus } from "@/lib/env";

export interface HistoryContext {
  id: string;
  userId: string;
  topic: string;
  summary: string;
  createdAt: number;
}

export interface HistoryHit {
  context: HistoryContext;
  score: number;
}

export interface HistoricalContextProvider {
  readonly backend: "backboard" | "sandbox";
  store(ctx: { userId: string; topic: string; summary: string }): Promise<HistoryContext>;
  retrieve(opts: { userId: string; query: string; limit?: number }): Promise<HistoryHit[]>;
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it", "me", "my", "i", "been", "have", "had", "about", "last", "this", "that"]);
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t));
}

export class SandboxHistoricalContext implements HistoricalContextProvider {
  readonly backend = "sandbox" as const;
  private rows: HistoryContext[] = [];

  async store(ctx: { userId: string; topic: string; summary: string }): Promise<HistoryContext> {
    const row: HistoryContext = { id: id("bb"), userId: ctx.userId, topic: ctx.topic, summary: ctx.summary, createdAt: now() };
    this.rows.push(row);
    return row;
  }
  async retrieve(opts: { userId: string; query: string; limit?: number }): Promise<HistoryHit[]> {
    const terms = tokenize(opts.query);
    const hits: HistoryHit[] = [];
    for (const row of this.rows) {
      if (row.userId !== opts.userId) continue; // isolation
      const hay = `${row.topic} ${row.summary}`.toLowerCase();
      const overlap = terms.filter((t) => hay.includes(t)).length;
      if (terms.length && overlap === 0) continue;
      hits.push({ context: row, score: terms.length ? overlap / terms.length : 0.5 });
    }
    hits.sort((a, b) => b.score - a.score || b.context.createdAt - a.context.createdAt);
    return hits.slice(0, opts.limit ?? 3);
  }
}

export class BackboardHistoricalContext implements HistoricalContextProvider {
  readonly backend = "backboard" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = process.env.BACKBOARD_BASE_URL?.trim() || "https://api.backboard.io/v1",
  ) {}
  private async req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  }
  async store(ctx: { userId: string; topic: string; summary: string }): Promise<HistoryContext> {
    const res = await this.req("/contexts", { method: "POST", body: JSON.stringify(ctx) });
    if (!res.ok) throw new Error(`Backboard store failed: ${res.status}`);
    const data = (await res.json()) as Partial<HistoryContext>;
    return { id: data.id ?? id("bb"), userId: ctx.userId, topic: ctx.topic, summary: ctx.summary, createdAt: data.createdAt ?? now() };
  }
  async retrieve(opts: { userId: string; query: string; limit?: number }): Promise<HistoryHit[]> {
    const res = await this.req("/contexts/search", { method: "POST", body: JSON.stringify(opts) });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: HistoryHit[] };
    return (data.hits ?? []).filter((h) => h.context.userId === opts.userId);
  }
}

const GLOBAL_KEY = "__Sahaya_backboard__";

export function getHistoricalContextProvider(): HistoricalContextProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as HistoricalContextProvider;
  const provider = backboardStatus().mode === "live" && process.env.BACKBOARD_API_KEY
    ? new BackboardHistoricalContext(process.env.BACKBOARD_API_KEY)
    : new SandboxHistoricalContext();
  g[GLOBAL_KEY] = provider;
  return provider;
}
export function setHistoricalContextProvider(p: HistoricalContextProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetHistoricalContextProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
