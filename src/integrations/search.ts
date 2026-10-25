/**
 * Incident search (Track 4).
 *
 * After each incident is saved, a PII-redacted summary is indexed so the person
 * (and their authorized caregivers) can ask "has someone tried this scam before?".
 * Live with Elasticsearch when ELASTIC_URL + ELASTIC_API_KEY are set; otherwise a
 * local in-memory index with the SAME interface (honest sandbox). Search is always
 * scoped to the caller's own userId — a user never sees another user's incidents.
 */

import { elasticStatus } from "@/lib/env";

export interface IncidentDoc {
  incidentId: string;
  userId: string;
  channel: string;
  scamType: string;
  riskLevel: string;
  receivedAt: number;
  /** PII-redacted text used for matching + snippets. */
  text: string;
  signals: string[];
}

export interface SearchFilters {
  channel?: string;
  scamType?: string;
  from?: number;
  to?: number;
}

export interface SearchHit {
  doc: IncidentDoc;
  score: number;
  snippet: string;
}

export interface IncidentSearchIndex {
  readonly backend: "elastic" | "sandbox";
  index(doc: IncidentDoc): Promise<void>;
  search(opts: { query: string; userId: string; filters?: SearchFilters; limit?: number }): Promise<SearchHit[]>;
  clear(): Promise<void>;
}

/** Redact obvious PII before anything leaves for an external index (global rule 4). */
export function redactPII(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]")
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[phone]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\$\s?[\d,]+(?:\.\d{2})?/g, "[amount]")
    .trim();
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it", "me", "my", "your", "this", "that", "has", "have", "someone", "before", "tried"]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

const RISK_BOOST: Record<string, number> = { critical: 1.4, high: 1.2, medium: 1.05, low: 1 };

export class InMemorySearchIndex implements IncidentSearchIndex {
  readonly backend = "sandbox" as const;
  private docs: IncidentDoc[] = [];

  async index(doc: IncidentDoc): Promise<void> {
    this.docs = this.docs.filter((d) => d.incidentId !== doc.incidentId); // idempotent
    this.docs.push(doc);
  }

  async clear(): Promise<void> {
    this.docs = [];
  }

  async search(opts: { query: string; userId: string; filters?: SearchFilters; limit?: number }): Promise<SearchHit[]> {
    const terms = tokenize(opts.query);
    const f = opts.filters ?? {};
    const hits: SearchHit[] = [];

    for (const doc of this.docs) {
      if (doc.userId !== opts.userId) continue; // permission scope
      if (f.channel && doc.channel !== f.channel) continue;
      if (f.scamType && doc.scamType !== f.scamType) continue;
      if (f.from && doc.receivedAt < f.from) continue;
      if (f.to && doc.receivedAt > f.to) continue;

      const hay = `${doc.text} ${doc.scamType.replace(/_/g, " ")} ${doc.signals.join(" ")}`.toLowerCase();
      let overlap = 0;
      for (const t of terms) if (hay.includes(t)) overlap++;
      if (terms.length && overlap === 0) continue;

      const base = terms.length ? overlap / terms.length : 0.5;
      const score = base * (RISK_BOOST[doc.riskLevel] ?? 1);
      hits.push({ doc, score, snippet: doc.text.slice(0, 140) });
    }

    hits.sort((a, b) => b.score - a.score || b.doc.receivedAt - a.doc.receivedAt);
    return hits.slice(0, opts.limit ?? 5);
  }
}

/** Live Elasticsearch adapter (same interface). Used only when configured. */
export class ElasticSearchIndex implements IncidentSearchIndex {
  readonly backend = "elastic" as const;
  private readonly indexName = "Sahaya-incidents";

  constructor(private readonly url: string, private readonly apiKey: string) {}

  private async es(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        Authorization: `ApiKey ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }

  async index(doc: IncidentDoc): Promise<void> {
    await this.es(`/${this.indexName}/_doc/${encodeURIComponent(doc.incidentId)}`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
  }

  async clear(): Promise<void> {
    await this.es(`/${this.indexName}`, { method: "DELETE" });
  }

  async search(opts: { query: string; userId: string; filters?: SearchFilters; limit?: number }): Promise<SearchHit[]> {
    const f = opts.filters ?? {};
    const filter: unknown[] = [{ term: { userId: opts.userId } }];
    if (f.channel) filter.push({ term: { channel: f.channel } });
    if (f.scamType) filter.push({ term: { scamType: f.scamType } });
    if (f.from || f.to) filter.push({ range: { receivedAt: { gte: f.from, lte: f.to } } });

    const body = {
      size: opts.limit ?? 5,
      query: {
        bool: {
          must: opts.query ? [{ multi_match: { query: opts.query, fields: ["text", "scamType", "signals"] } }] : [{ match_all: {} }],
          filter,
        },
      },
    };
    const res = await this.es(`/${this.indexName}/_search`, { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: { hits?: { _score: number; _source: IncidentDoc }[] } };
    return (data.hits?.hits ?? []).map((h) => ({
      doc: h._source,
      score: h._score,
      snippet: (h._source.text ?? "").slice(0, 140),
    }));
  }
}

/** Process-wide singleton (like the data layer). Tests can reset/inject. */
const GLOBAL_KEY = "__Sahaya_incident_index__";

export function getIncidentIndex(): IncidentSearchIndex {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as IncidentSearchIndex;
  const status = elasticStatus();
  const index =
    status.mode === "live" && process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY
      ? new ElasticSearchIndex(process.env.ELASTIC_URL, process.env.ELASTIC_API_KEY)
      : new InMemorySearchIndex();
  g[GLOBAL_KEY] = index;
  return index;
}

/** For tests/demos: swap in a fresh index. */
export function setIncidentIndex(index: IncidentSearchIndex): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = index;
}

/** Map detected signals to a coarse scam type for filtering. */
export function scamTypeFromSignals(signals: string[]): string {
  if (signals.includes("family_impersonation")) return "fake_grandchild";
  if (signals.includes("gift_card") || signals.includes("irreversible_transfer")) return "gift_card";
  if (signals.includes("authority_threat")) return "fake_bank";
  if (signals.includes("tech_support")) return "tech_support";
  if (signals.includes("prize_bait")) return "prize";
  if (signals.includes("code_request") || signals.includes("sensitive_numbers")) return "credential";
  return "unknown";
}
