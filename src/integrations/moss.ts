/**
 * Moss — personal memory / continuity provider (Part 5, Track B, step 5).
 *
 * Moss stores the small, durable "continuity context" that makes Wellness feel
 * personal across conversations: stated preferences, who matters to the person,
 * recurring themes. It is NOT the canonical observation record (that is Convex) —
 * it is a supplementary personalization layer, so a Moss failure never corrupts
 * the canonical data.
 *
 * Live with MOSS_API_KEY; otherwise an in-process sandbox with the same interface.
 * Every method is scoped to a single userId, so one person's continuity context
 * can never be read for another (defends cross-user access).
 */

import { id, now } from "@/lib/id";
import { mossStatus } from "@/lib/env";

export interface ContinuityItem {
  id: string;
  userId: string;
  kind: "preference" | "note" | "fact";
  text: string;
  createdAt: number;
}

export interface PersonalMemoryProvider {
  readonly backend: "moss" | "sandbox";
  save(item: { userId: string; kind: ContinuityItem["kind"]; text: string }): Promise<ContinuityItem>;
  list(userId: string, opts?: { kind?: ContinuityItem["kind"]; limit?: number }): Promise<ContinuityItem[]>;
  remove(userId: string, itemId: string): Promise<boolean>;
}

export class SandboxPersonalMemory implements PersonalMemoryProvider {
  readonly backend = "sandbox" as const;
  private items: ContinuityItem[] = [];

  async save(item: { userId: string; kind: ContinuityItem["kind"]; text: string }): Promise<ContinuityItem> {
    const row: ContinuityItem = { id: id("moss"), userId: item.userId, kind: item.kind, text: item.text, createdAt: now() };
    this.items.push(row);
    return row;
  }
  async list(userId: string, opts?: { kind?: ContinuityItem["kind"]; limit?: number }): Promise<ContinuityItem[]> {
    let rows = this.items.filter((i) => i.userId === userId); // userId scope = isolation
    if (opts?.kind) rows = rows.filter((i) => i.kind === opts.kind);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }
  async remove(userId: string, itemId: string): Promise<boolean> {
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.id === itemId && i.userId === userId));
    return this.items.length < before;
  }
}

/** Live Moss adapter (same interface). Used only when MOSS_API_KEY is configured. */
export class MossPersonalMemory implements PersonalMemoryProvider {
  readonly backend = "moss" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = process.env.MOSS_BASE_URL?.trim() || "https://api.moss.ai/v1",
  ) {}

  private async req(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  }
  async save(item: { userId: string; kind: ContinuityItem["kind"]; text: string }): Promise<ContinuityItem> {
    const res = await this.req("/memories", { method: "POST", body: JSON.stringify(item) });
    if (!res.ok) throw new Error(`Moss save failed: ${res.status}`);
    const data = (await res.json()) as Partial<ContinuityItem>;
    return { id: data.id ?? id("moss"), userId: item.userId, kind: item.kind, text: item.text, createdAt: data.createdAt ?? now() };
  }
  async list(userId: string, opts?: { kind?: ContinuityItem["kind"]; limit?: number }): Promise<ContinuityItem[]> {
    const q = new URLSearchParams({ userId, ...(opts?.kind ? { kind: opts.kind } : {}), ...(opts?.limit ? { limit: String(opts.limit) } : {}) });
    const res = await this.req(`/memories?${q.toString()}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: ContinuityItem[] };
    return (data.items ?? []).filter((i) => i.userId === userId);
  }
  async remove(userId: string, itemId: string): Promise<boolean> {
    const res = await this.req(`/memories/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
    return res.ok;
  }
}

const GLOBAL_KEY = "__kinline_moss__";

export function getPersonalMemoryProvider(): PersonalMemoryProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as PersonalMemoryProvider;
  const provider = mossStatus().mode === "live" && process.env.MOSS_API_KEY
    ? new MossPersonalMemory(process.env.MOSS_API_KEY)
    : new SandboxPersonalMemory();
  g[GLOBAL_KEY] = provider;
  return provider;
}

export function setPersonalMemoryProvider(p: PersonalMemoryProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetPersonalMemoryProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
