/**
 * Incident search (Track 4).
 *
 * After each incident is saved, the indexing job (agents/guardian/incidentIndexer)
 * writes a PII-redacted, field-allowlisted projection here so the person (and
 * their authorized caregivers) can ask "has someone tried this scam before?".
 * Live with Elasticsearch when ELASTIC_URL + ELASTIC_API_KEY are set; otherwise a
 * local in-memory index with the SAME interface (honest sandbox). Search is always
 * scoped to the caller's own userId: a user never sees another user's incidents.
 */

import { elasticStatus } from "@/lib/env";

export interface IncidentDoc {
  incidentId: string;
  userId: string;
  channel: string;
  scamType: string;
  riskLevel: string;
  outcome?: string;
  receivedAt: number;
  /** PII-redacted text used for matching + snippets. */
  text: string;
  /** Scam signal codes (e.g. "gift_card", "family_impersonation"). */
  signals: string[];
  /** Human-readable tactic labels for the signals, so they are full-text searchable. */
  tactics?: string[];
}

export interface SearchFilters {
  channel?: string;
  scamType?: string;
  from?: number;
  to?: number;
}

export interface SearchOptions {
  query: string;
  userId: string;
  filters?: SearchFilters;
  /** Signal codes detected in the query; incidents sharing them rank higher. */
  signals?: string[];
  /** e.g. the incident being asked about, so it does not match itself. */
  excludeIncidentIds?: string[];
  limit?: number;
}

export interface SearchHit {
  doc: IncidentDoc;
  score: number;
  /** Evidence: the matching passage of the incident text. */
  snippet: string;
  /** Query terms found in the incident (evidence for the similarity). */
  matchedTerms: string[];
  /** Signal codes the incident shares with the query. */
  sharedSignals: string[];
}

export interface IncidentSearchIndex {
  readonly backend: "elastic" | "sandbox";
  index(doc: IncidentDoc): Promise<void>;
  search(opts: SearchOptions): Promise<SearchHit[]>;
  /** Delete every document for one user (demo cleanup, account deletion). */
  removeUser(userId: string): Promise<void>;
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

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "is", "it", "me", "my", "your", "this", "that", "has", "have", "someone", "before", "tried", "please", "with", "was", "are", "you"]);

function tokenize(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !STOP.has(t)),
    ),
  ];
}

const RISK_BOOST: Record<string, number> = { critical: 1.4, high: 1.2, medium: 1.05, low: 1 };

function sharedSignals(doc: IncidentDoc, signals: string[] | undefined): string[] {
  if (!signals?.length) return [];
  return signals.filter((s) => doc.signals.includes(s));
}

export class InMemorySearchIndex implements IncidentSearchIndex {
  readonly backend = "sandbox" as const;
  private docs: IncidentDoc[] = [];

  async index(doc: IncidentDoc): Promise<void> {
    this.docs = this.docs.filter((d) => d.incidentId !== doc.incidentId); // idempotent
    this.docs.push(doc);
  }

  async removeUser(userId: string): Promise<void> {
    this.docs = this.docs.filter((d) => d.userId !== userId);
  }

  async clear(): Promise<void> {
    this.docs = [];
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const terms = tokenize(opts.query);
    const f = opts.filters ?? {};
    const exclude = new Set(opts.excludeIncidentIds ?? []);
    const querySignals = [...new Set(opts.signals ?? [])];
    const hits: SearchHit[] = [];

    for (const doc of this.docs) {
      if (doc.userId !== opts.userId) continue; // permission scope
      if (exclude.has(doc.incidentId)) continue;
      if (f.channel && doc.channel !== f.channel) continue;
      if (f.scamType && doc.scamType !== f.scamType) continue;
      if (f.from && doc.receivedAt < f.from) continue;
      if (f.to && doc.receivedAt > f.to) continue;

      const hay = `${doc.text} ${doc.scamType.replace(/_/g, " ")} ${(doc.tactics ?? []).join(" ")}`.toLowerCase();
      const matchedTerms = terms.filter((t) => hay.includes(t));
      const shared = sharedSignals(doc, querySignals);
      if (terms.length && !matchedTerms.length && !shared.length) continue;

      const termScore = terms.length ? matchedTerms.length / terms.length : 0.5;
      let base = termScore;
      if (querySignals.length) {
        // Tactic similarity (Jaccard): shared signals over the union, so an
        // incident that only shares one generic tactic ranks below a close match.
        const union = new Set([...querySignals, ...doc.signals]).size;
        base = 0.4 * termScore + 0.6 * (shared.length / union);
      }
      const score = base * (RISK_BOOST[doc.riskLevel] ?? 1);
      hits.push({ doc, score, snippet: doc.text.slice(0, 160), matchedTerms, sharedSignals: shared });
    }

    hits.sort((a, b) => b.score - a.score || b.doc.receivedAt - a.doc.receivedAt);
    return hits.slice(0, opts.limit ?? 5);
  }
}

/** Live Elasticsearch adapter (same interface). Used only when configured. */
export class ElasticSearchIndex implements IncidentSearchIndex {
  readonly backend = "elastic" as const;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly indexName = "kinline-incidents",
  ) {}

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
    // refresh=true so a just-indexed incident is immediately searchable (the
    // "has this happened before?" flow indexes then asks in the same turn).
    const res = await this.es(`/${this.indexName}/_doc/${encodeURIComponent(doc.incidentId)}?refresh=true`, {
      method: "PUT",
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      throw new Error(`[elastic] index ${doc.incidentId} failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  async removeUser(userId: string): Promise<void> {
    const res = await this.es(`/${this.indexName}/_delete_by_query?refresh=true`, {
      method: "POST",
      body: JSON.stringify({ query: { term: { "userId.keyword": userId } } }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`[elastic] removeUser failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  async clear(): Promise<void> {
    const res = await this.es(`/${this.indexName}`, { method: "DELETE" });
    // 404 is fine (index never created yet); surface anything else.
    if (!res.ok && res.status !== 404) {
      console.warn(`[elastic] clear failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    const f = opts.filters ?? {};
    // Dynamic mapping types string fields as `text` with a `.keyword` sub-field.
    // Exact-match `term` filters MUST target `.keyword`, or every search returns
    // zero hits (and the per-user permission scope silently stops working).
    const filter: unknown[] = [{ term: { "userId.keyword": opts.userId } }];
    if (f.channel) filter.push({ term: { "channel.keyword": f.channel } });
    if (f.scamType) filter.push({ term: { "scamType.keyword": f.scamType } });
    if (f.from || f.to) filter.push({ range: { receivedAt: { gte: f.from, lte: f.to } } });

    const should: unknown[] = [];
    if (opts.query) should.push({ multi_match: { query: opts.query, fields: ["text^2", "tactics", "scamType"] } });
    for (const s of new Set(opts.signals ?? [])) should.push({ term: { "signals.keyword": { value: s, boost: 1.5 } } });

    const body = {
      size: opts.limit ?? 5,
      query: {
        bool: {
          ...(should.length ? { should, minimum_should_match: 1 } : { must: [{ match_all: {} }] }),
          filter,
          ...(opts.excludeIncidentIds?.length
            ? { must_not: [{ terms: { "incidentId.keyword": opts.excludeIncidentIds } }] }
            : {}),
        },
      },
      highlight: { fields: { text: { number_of_fragments: 1, fragment_size: 160, no_match_size: 160 } } },
    };
    const res = await this.es(`/${this.indexName}/_search`, { method: "POST", body: JSON.stringify(body) });
    if (res.status === 404) return []; // index not created yet: no history
    if (!res.ok) {
      throw new Error(`[elastic] search failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as {
      hits?: { hits?: { _score: number; _source: IncidentDoc; highlight?: { text?: string[] } }[] };
    };
    return (data.hits?.hits ?? []).map((h) => {
      const frag = h.highlight?.text?.[0] ?? (h._source.text ?? "").slice(0, 160);
      const matchedTerms = [...new Set([...frag.matchAll(/<em>(.*?)<\/em>/g)].map((m) => m[1].toLowerCase()))];
      const doc = { ...h._source, signals: h._source.signals ?? [] };
      return {
        doc,
        score: h._score,
        snippet: frag.replace(/<\/?em>/g, ""),
        matchedTerms,
        sharedSignals: sharedSignals(doc, opts.signals),
      };
    });
  }
}

/** Process-wide singleton (like the data layer). Tests can reset/inject. */
const GLOBAL_KEY = "__kinline_incident_index__";

export function getIncidentIndex(): IncidentSearchIndex {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as IncidentSearchIndex;
  const status = elasticStatus();
  const index =
    status.mode === "live" && process.env.ELASTIC_URL && process.env.ELASTIC_API_KEY
      ? new ElasticSearchIndex(process.env.ELASTIC_URL, process.env.ELASTIC_API_KEY, process.env.ELASTIC_INDEX || undefined)
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
