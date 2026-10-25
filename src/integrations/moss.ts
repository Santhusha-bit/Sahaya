/**
 * Moss: real-time retrieval index used for Wellness continuity.
 *
 * What Moss actually offers (verified against docs.moss.dev, 2026-10-24):
 *   - Control plane REST: POST https://service.usemoss.dev/v1/manage
 *     headers `x-service-version: v1`, `x-project-key: <key>`; body carries
 *     `action` + `projectId`. Actions used here: `addDocs` (docs: {id,text,metadata},
 *     options.upsert), `getDocs` (options.docIds), `deleteDocs` (docIds),
 *     `listIndexes`. Mutations are async (return {jobId, status:"building"}).
 *   - Search runs in the `@moss-js/moss` SDK after `loadIndex` (in-process). There
 *     is no documented REST search endpoint, and REST index creation needs
 *     pre-computed embeddings, so the index is created once by the operator.
 *   - The docs make NO promises about encryption at rest, retention or compliance,
 *     and SDK telemetry is always on (index names are sent verbatim).
 *
 * Consequence for Sahaya: Moss is NOT the system of record for sensitive memory.
 * Convex is canonical. Moss only receives minimized, consented continuity cues
 * keyed by opaque ids and a pseudonymous subject (see continuityMemory.ts), and
 * retrieval asks Moss only for doc ids Convex says belong to the user.
 *
 * Live when MOSS_PROJECT_ID + MOSS_PROJECT_KEY + MOSS_INDEX_NAME are set;
 * otherwise an in-process sandbox with the same semantics.
 */

import { createHmac } from "node:crypto";

export interface MossDoc {
  /** Opaque id. Never contains personal data. */
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export interface PersonalMemoryProvider {
  readonly backend: "moss" | "sandbox";
  upsert(docs: MossDoc[]): Promise<void>;
  /** Fetch ONLY the requested doc ids. An empty list returns nothing. */
  get(docIds: string[]): Promise<MossDoc[]>;
  remove(docIds: string[]): Promise<void>;
}

export class SandboxPersonalMemory implements PersonalMemoryProvider {
  readonly backend = "sandbox" as const;
  private docs = new Map<string, MossDoc>();

  async upsert(docs: MossDoc[]): Promise<void> {
    for (const d of docs) this.docs.set(d.id, { ...d, metadata: { ...d.metadata } });
  }
  async get(docIds: string[]): Promise<MossDoc[]> {
    return docIds.map((i) => this.docs.get(i)).filter((d): d is MossDoc => !!d);
  }
  async remove(docIds: string[]): Promise<void> {
    for (const i of docIds) this.docs.delete(i);
  }
  /** Test/demo helper: raw view of everything stored (what Moss would hold). */
  dump(): MossDoc[] {
    return [...this.docs.values()];
  }
}

export interface MossConfig {
  projectId: string;
  projectKey: string;
  indexName: string;
  baseUrl?: string;
}

/** Live Moss control-plane adapter, using only documented actions. */
export class MossPersonalMemory implements PersonalMemoryProvider {
  readonly backend = "moss" as const;
  private readonly baseUrl: string;

  constructor(private readonly cfg: MossConfig) {
    this.baseUrl = (cfg.baseUrl || "https://service.usemoss.dev/v1").replace(/\/$/, "");
  }

  private async manage<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/manage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-version": "v1",
        "x-project-key": this.cfg.projectKey,
      },
      body: JSON.stringify({ action, projectId: this.cfg.projectId, ...body }),
    });
    if (!res.ok) throw new Error(`Moss ${action} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async upsert(docs: MossDoc[]): Promise<void> {
    if (!docs.length) return;
    await this.manage("addDocs", { indexName: this.cfg.indexName, docs, options: { upsert: true } });
  }
  async get(docIds: string[]): Promise<MossDoc[]> {
    if (!docIds.length) return [];
    const rows = await this.manage<unknown>("getDocs", { indexName: this.cfg.indexName, options: { docIds } });
    const list = Array.isArray(rows) ? rows : [];
    const wanted = new Set(docIds);
    return list
      .filter((r): r is MossDoc => !!r && typeof (r as MossDoc).id === "string" && typeof (r as MossDoc).text === "string")
      .filter((r) => wanted.has(r.id)) // never trust the server to have filtered
      .map((r) => ({ id: r.id, text: r.text, metadata: (r.metadata ?? {}) as Record<string, string> }));
  }
  async remove(docIds: string[]): Promise<void> {
    if (!docIds.length) return;
    await this.manage("deleteDocs", { indexName: this.cfg.indexName, docIds });
  }

  /** Real round-trip check: credentials valid AND the configured index exists. */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const out = await this.manage<unknown>("listIndexes", {});
      const list = Array.isArray(out) ? out : ((out as { indexes?: unknown[] })?.indexes ?? []);
      const names = list.map((i) => (typeof i === "string" ? i : (i as { name?: string })?.name)).filter(Boolean);
      return names.includes(this.cfg.indexName)
        ? { ok: true, detail: `Credentials valid; index "${this.cfg.indexName}" found.` }
        : { ok: false, detail: `Credentials valid but index "${this.cfg.indexName}" not found (have: ${names.join(", ") || "none"}).` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function mossConfigFromEnv(): MossConfig | null {
  const projectId = process.env.MOSS_PROJECT_ID?.trim();
  const projectKey = (process.env.MOSS_PROJECT_KEY || process.env.MOSS_API_KEY)?.trim();
  const indexName = process.env.MOSS_INDEX_NAME?.trim();
  if (!projectId || !projectKey || !indexName) return null;
  return { projectId, projectKey, indexName, baseUrl: process.env.MOSS_BASE_URL?.trim() || undefined };
}

/**
 * Pseudonymous subject for a user. Moss never sees the raw userId; the mapping
 * lives only in Convex. Salted so subjects can't be recomputed from a known id.
 */
export function mossSubject(userId: string): string {
  const salt = process.env.MOSS_SUBJECT_SALT?.trim() || "sahaya-dev-salt";
  return createHmac("sha256", salt).update(userId).digest("hex").slice(0, 24);
}

const GLOBAL_KEY = "__Sahaya_moss__";

export function getPersonalMemoryProvider(): PersonalMemoryProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as PersonalMemoryProvider;
  const cfg = mossConfigFromEnv();
  const provider = cfg ? new MossPersonalMemory(cfg) : new SandboxPersonalMemory();
  g[GLOBAL_KEY] = provider;
  return provider;
}

export function setPersonalMemoryProvider(p: PersonalMemoryProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetPersonalMemoryProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
