/**
 * Snowflake: authorized household analytics (Part 5, Track B, steps 10-11, plus
 * the monthly family care summary).
 *
 * Snowflake receives ONLY de-identified data for a household, never raw
 * conversations, drug names, request text, or notes:
 *   - `household_analytics`: numeric Wellness aggregates (average sleep, check-in
 *     count). The type carries no free text, so a raw conversation cannot be
 *     published here (defends cases 20, 22).
 *   - `household_care_facts`: one row per consented Care record, reduced to
 *     (category, outcome, day). The monthly summary is computed IN Snowflake by a
 *     single GROUP BY query; Sahaya only reads the aggregate result back.
 *
 * Enforcement built into this layer:
 *   - idempotent publish on (householdId, period, metric): a repeated sync does
 *     not create duplicate analytics rows (case 30). Care facts are loaded with
 *     replace-partition semantics, so a re-export never duplicates and picks up
 *     corrections or deletions in the canonical Convex records.
 *   - every care fact is validated against a strict schema before it leaves, so
 *     an extra field (a name, a note) is rejected rather than exported.
 *   - query is scoped to the requester's authorized households: a caregiver can
 *     never read another household's analytics (cases 19).
 *   - withdraw() removes data when consent is revoked, and queries exclude
 *     withdrawn rows, so revoked data stops appearing in analytics (case 21).
 *
 * Live with SNOWFLAKE_ACCOUNT + SNOWFLAKE_TOKEN (SQL REST API, /api/v2/statements);
 * otherwise an in-process sandbox with the same interface and the same math.
 */

import { z } from "zod";
import { id, now } from "@/lib/id";
import { snowflakeStatus } from "@/lib/env";

export type AggregateMetric = "sleep_avg_hours" | "energy_direction_score" | "checkin_count" | "concern_count";

export interface HouseholdAggregate {
  id: string;
  householdId: string;
  /** Calendar period, e.g. "2026-10". */
  period: string;
  metric: AggregateMetric;
  value: number;
  /** How many observations backed this aggregate (for honesty about coverage). */
  observationCount: number;
  generatedAt: number;
  withdrawn?: boolean;
}

export interface PublishInput {
  householdId: string;
  period: string;
  metric: AggregateMetric;
  value: number;
  observationCount: number;
}

// ---- Care facts (monthly family care summary) -------------------------------

export const CARE_FACT_CATEGORIES = ["medication_confirmation", "assistance_request"] as const;
export type CareFactCategory = (typeof CARE_FACT_CATEGORIES)[number];

export const CARE_FACT_OUTCOMES = ["taken", "skipped", "completed", "open", "declined"] as const;
export type CareFactOutcome = (typeof CARE_FACT_OUTCOMES)[number];

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The ONLY shape a care record may take on its way to Snowflake. `.strict()`
 * rejects any additional field, so a medication name or request text cannot ride
 * along by accident.
 */
export const careFactSchema = z
  .object({
    /** Opaque hash of the source record; never the Convex id itself. */
    factId: z.string().regex(/^[a-f0-9]{24}$/),
    householdId: z.string().min(1).max(80),
    period: z.string().regex(PERIOD_RE),
    category: z.enum(CARE_FACT_CATEGORIES),
    outcome: z.enum(CARE_FACT_OUTCOMES),
    /** Day the record happened, YYYY-MM-DD. No time of day. */
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type CareFact = z.infer<typeof careFactSchema>;

export interface CareSummaryRow {
  period: string;
  category: CareFactCategory;
  total: number;
  outcomes: Record<CareFactOutcome, number>;
  /** Distinct days with at least one record (coverage, not behaviour). */
  activeDays: number;
}

export function isPeriod(v: string): boolean {
  return PERIOD_RE.test(v);
}

function emptyOutcomes(): Record<CareFactOutcome, number> {
  return { taken: 0, skipped: 0, completed: 0, open: 0, declined: 0 };
}

/**
 * Reference aggregation: what the Snowflake GROUP BY computes. The sandbox runs
 * this directly so both backends produce identical summaries.
 */
export function summarizeCareFacts(facts: CareFact[]): CareSummaryRow[] {
  const groups = new Map<string, { row: CareSummaryRow; days: Set<string> }>();
  for (const f of facts) {
    const k = `${f.period}|${f.category}`;
    let g = groups.get(k);
    if (!g) {
      g = { row: { period: f.period, category: f.category, total: 0, outcomes: emptyOutcomes(), activeDays: 0 }, days: new Set() };
      groups.set(k, g);
    }
    g.row.total++;
    g.row.outcomes[f.outcome]++;
    g.days.add(f.occurredOn);
  }
  return [...groups.values()]
    .map(({ row, days }) => ({ ...row, activeDays: days.size }))
    .sort((a, b) => (a.period === b.period ? a.category.localeCompare(b.category) : a.period < b.period ? 1 : -1));
}

function validateFacts(opts: { householdId: string; category: CareFactCategory; periods: string[]; facts: CareFact[] }): CareFact[] {
  if (!opts.periods.every(isPeriod)) throw new Error("Invalid analytics period.");
  return opts.facts.map((raw) => {
    const f = careFactSchema.parse(raw);
    if (f.householdId !== opts.householdId || f.category !== opts.category || !opts.periods.includes(f.period)) {
      throw new Error("Care fact is outside the partition being exported.");
    }
    return f;
  });
}

export interface AnalyticsProvider {
  readonly backend: "snowflake" | "sandbox";
  /** Idempotent on (householdId, period, metric): updates in place, never duplicates. */
  publish(agg: PublishInput): Promise<{ written: boolean; record: HouseholdAggregate }>;
  /** Scoped to authorized households. Excludes withdrawn rows. */
  query(opts: { householdId: string; authorizedHouseholds: string[]; limit?: number }): Promise<HouseholdAggregate[]>;
  /** Withdraw aggregates on consent revocation. Returns count withdrawn. */
  withdraw(opts: { householdId: string; period?: string }): Promise<number>;
  /**
   * Replace one household's facts for a category over the given periods. Running
   * it twice with the same input leaves the same rows (idempotent).
   */
  replaceCareFacts(opts: { householdId: string; category: CareFactCategory; periods: string[]; facts: CareFact[] }): Promise<{ loaded: number }>;
  /** Remove every fact in a category for a household (consent revoked). */
  withdrawCareFacts(opts: { householdId: string; category: CareFactCategory }): Promise<number>;
  /** Aggregate summary per (period, category). Scoped to authorized households. */
  summarizeCare(opts: { householdId: string; authorizedHouseholds: string[]; periods: string[] }): Promise<CareSummaryRow[]>;
}

function key(a: { householdId: string; period: string; metric: string }): string {
  return `${a.householdId}|${a.period}|${a.metric}`;
}

export class SandboxAnalytics implements AnalyticsProvider {
  readonly backend = "sandbox" as const;
  private rows = new Map<string, HouseholdAggregate>();
  private facts = new Map<string, CareFact>();

  async publish(agg: PublishInput): Promise<{ written: boolean; record: HouseholdAggregate }> {
    const k = key(agg);
    const existing = this.rows.get(k);
    if (existing) {
      const updated: HouseholdAggregate = { ...existing, value: agg.value, observationCount: agg.observationCount, generatedAt: now(), withdrawn: false };
      this.rows.set(k, updated);
      return { written: false, record: updated };
    }
    const record: HouseholdAggregate = {
      id: id("sf"), householdId: agg.householdId, period: agg.period, metric: agg.metric,
      value: agg.value, observationCount: agg.observationCount, generatedAt: now(),
    };
    this.rows.set(k, record);
    return { written: true, record };
  }

  async query(opts: { householdId: string; authorizedHouseholds: string[]; limit?: number }): Promise<HouseholdAggregate[]> {
    // Authorization: requester must be allowed to see THIS household's analytics.
    if (!opts.authorizedHouseholds.includes(opts.householdId)) return [];
    const rows = [...this.rows.values()]
      .filter((r) => r.householdId === opts.householdId && !r.withdrawn)
      .sort((a, b) => (a.period < b.period ? 1 : -1));
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async withdraw(opts: { householdId: string; period?: string }): Promise<number> {
    let n = 0;
    for (const [k, r] of this.rows) {
      if (r.householdId === opts.householdId && (!opts.period || r.period === opts.period) && !r.withdrawn) {
        this.rows.set(k, { ...r, withdrawn: true });
        n++;
      }
    }
    return n;
  }

  async replaceCareFacts(opts: { householdId: string; category: CareFactCategory; periods: string[]; facts: CareFact[] }): Promise<{ loaded: number }> {
    const facts = validateFacts(opts);
    for (const [k, f] of this.facts) {
      if (f.householdId === opts.householdId && f.category === opts.category && opts.periods.includes(f.period)) this.facts.delete(k);
    }
    for (const f of facts) this.facts.set(f.factId, f);
    return { loaded: facts.length };
  }

  async withdrawCareFacts(opts: { householdId: string; category: CareFactCategory }): Promise<number> {
    let n = 0;
    for (const [k, f] of this.facts) {
      if (f.householdId === opts.householdId && f.category === opts.category) {
        this.facts.delete(k);
        n++;
      }
    }
    return n;
  }

  async summarizeCare(opts: { householdId: string; authorizedHouseholds: string[]; periods: string[] }): Promise<CareSummaryRow[]> {
    if (!opts.authorizedHouseholds.includes(opts.householdId)) return [];
    const facts = [...this.facts.values()].filter((f) => f.householdId === opts.householdId && opts.periods.includes(f.period));
    return summarizeCareFacts(facts);
  }
}

// ---- Live Snowflake (SQL REST API) ------------------------------------------

export interface SnowflakeConfig {
  /** Account identifier, e.g. "myorg-myaccount". */
  account: string;
  token: string;
  /** PROGRAMMATIC_ACCESS_TOKEN (default), KEYPAIR_JWT, or OAUTH. */
  tokenType?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
}

type Binding = { type: "TEXT" | "FIXED" | "REAL"; value: string };
const text = (v: string): Binding => ({ type: "TEXT", value: v });
const fixed = (v: number): Binding => ({ type: "FIXED", value: String(Math.trunc(v)) });
const real = (v: number): Binding => ({ type: "REAL", value: String(v) });

const SCHEMA_DDL = [
  "CREATE TABLE IF NOT EXISTS household_analytics (household_id STRING, period STRING, metric STRING, value FLOAT, observation_count NUMBER, withdrawn BOOLEAN DEFAULT FALSE, generated_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())",
  "CREATE TABLE IF NOT EXISTS household_care_facts (fact_id STRING, household_id STRING, period STRING, category STRING, outcome STRING, occurred_on DATE, loaded_at TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP())",
];

/** Rows per INSERT; keeps each statement well under the binding limits. */
const INSERT_CHUNK = 100;

/**
 * Host for SNOWFLAKE_ACCOUNT. Accepts the identifier ("myorg-myaccount",
 * "xy12345.us-east-2.aws") or a pasted Snowsight/account URL; an underscore in
 * the account name becomes a hyphen, as Snowflake hostnames require.
 */
export function snowflakeAccountHost(account: string): string {
  const id = account
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\.snowflakecomputing\.com$/i, "")
    .toLowerCase()
    .replace(/_/g, "-");
  return `${id}.snowflakecomputing.com`;
}

export class SnowflakeAnalytics implements AnalyticsProvider {
  readonly backend = "snowflake" as const;
  private ready: Promise<void> | null = null;

  constructor(private readonly cfg: SnowflakeConfig) {}

  private get baseUrl(): string {
    return `https://${snowflakeAccountHost(this.cfg.account)}/api/v2/statements`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      "X-Snowflake-Authorization-Token-Type": this.cfg.tokenType ?? "PROGRAMMATIC_ACCESS_TOKEN",
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** Run one statement and return rows keyed by lower-cased column name. */
  private async sql(statement: string, bindings: Binding[] = []): Promise<Record<string, string | null>[]> {
    let res = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        statement,
        timeout: 60,
        warehouse: this.cfg.warehouse,
        database: this.cfg.database,
        schema: this.cfg.schema,
        role: this.cfg.role,
        bindings: bindings.length ? Object.fromEntries(bindings.map((b, i) => [String(i + 1), b])) : undefined,
      }),
    });
    // 202 = still running; poll the statement handle briefly.
    for (let attempt = 0; res.status === 202 && attempt < 20; attempt++) {
      const pending = (await res.json()) as { statementHandle?: string };
      if (!pending.statementHandle) break;
      await new Promise((r) => setTimeout(r, 500));
      res = await fetch(`${this.baseUrl}/${pending.statementHandle}`, { headers: this.headers() });
    }
    if (res.status === 404) {
      // Snowflake answers an unknown account host with a generic HTML 404.
      throw new Error(
        `Snowflake account "${this.cfg.account}" was not found at ${snowflakeAccountHost(this.cfg.account)} (404). ` +
          "Set SNOWFLAKE_ACCOUNT to the account identifier from Snowsight (orgname-accountname) or to locator.region.cloud; " +
          "a bare locator only works for AWS us-west-2.",
      );
    }
    if (res.status !== 200) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Snowflake statement failed (${res.status})${body.message ? `: ${body.message}` : ""}`);
    }
    const out = (await res.json()) as {
      resultSetMetaData?: { rowType?: { name: string }[] };
      data?: (string | null)[][];
    };
    const cols = (out.resultSetMetaData?.rowType ?? []).map((c) => c.name.toLowerCase());
    return (out.data ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i] ?? null])));
  }

  private ensureSchema(): Promise<void> {
    this.ready ??= (async () => {
      for (const ddl of SCHEMA_DDL) await this.sql(ddl);
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** DML statements return their affected-row count in the first column. */
  private static affected(rows: Record<string, string | null>[]): number {
    const first = rows[0] ? Object.values(rows[0])[0] : null;
    return Number(first ?? 0) || 0;
  }

  async publish(agg: PublishInput): Promise<{ written: boolean; record: HouseholdAggregate }> {
    await this.ensureSchema();
    await this.sql(
      "MERGE INTO household_analytics t USING (SELECT ? hh, ? period, ? metric, ? value, ? cnt) s ON t.household_id=s.hh AND t.period=s.period AND t.metric=s.metric WHEN MATCHED THEN UPDATE SET value=s.value, observation_count=s.cnt, withdrawn=FALSE, generated_at=CURRENT_TIMESTAMP() WHEN NOT MATCHED THEN INSERT (household_id, period, metric, value, observation_count) VALUES (s.hh, s.period, s.metric, s.value, s.cnt)",
      [text(agg.householdId), text(agg.period), text(agg.metric), real(agg.value), fixed(agg.observationCount)],
    );
    return { written: true, record: { id: id("sf"), ...agg, generatedAt: now() } };
  }

  async query(opts: { householdId: string; authorizedHouseholds: string[]; limit?: number }): Promise<HouseholdAggregate[]> {
    if (!opts.authorizedHouseholds.includes(opts.householdId)) return [];
    await this.ensureSchema();
    const rows = await this.sql(
      `SELECT household_id, period, metric, value, observation_count FROM household_analytics WHERE household_id=? AND withdrawn=FALSE ORDER BY period DESC${opts.limit ? ` LIMIT ${Math.trunc(opts.limit)}` : ""}`,
      [text(opts.householdId)],
    );
    return rows.map((r) => ({
      id: id("sf"), householdId: String(r.household_id), period: String(r.period),
      metric: r.metric as AggregateMetric, value: Number(r.value), observationCount: Number(r.observation_count), generatedAt: now(),
    }));
  }

  async withdraw(opts: { householdId: string; period?: string }): Promise<number> {
    await this.ensureSchema();
    const rows = await this.sql(
      `UPDATE household_analytics SET withdrawn=TRUE WHERE household_id=? AND withdrawn=FALSE${opts.period ? " AND period=?" : ""}`,
      opts.period ? [text(opts.householdId), text(opts.period)] : [text(opts.householdId)],
    );
    return SnowflakeAnalytics.affected(rows);
  }

  async replaceCareFacts(opts: { householdId: string; category: CareFactCategory; periods: string[]; facts: CareFact[] }): Promise<{ loaded: number }> {
    const facts = validateFacts(opts);
    await this.ensureSchema();
    await this.sql(
      `DELETE FROM household_care_facts WHERE household_id=? AND category=? AND period IN (${opts.periods.map(() => "?").join(",")})`,
      [text(opts.householdId), text(opts.category), ...opts.periods.map(text)],
    );
    for (let i = 0; i < facts.length; i += INSERT_CHUNK) {
      const chunk = facts.slice(i, i + INSERT_CHUNK);
      await this.sql(
        `INSERT INTO household_care_facts (fact_id, household_id, period, category, outcome, occurred_on) VALUES ${chunk.map(() => "(?,?,?,?,?,?)").join(",")}`,
        chunk.flatMap((f) => [text(f.factId), text(f.householdId), text(f.period), text(f.category), text(f.outcome), text(f.occurredOn)]),
      );
    }
    return { loaded: facts.length };
  }

  async withdrawCareFacts(opts: { householdId: string; category: CareFactCategory }): Promise<number> {
    await this.ensureSchema();
    const rows = await this.sql("DELETE FROM household_care_facts WHERE household_id=? AND category=?", [
      text(opts.householdId),
      text(opts.category),
    ]);
    return SnowflakeAnalytics.affected(rows);
  }

  async summarizeCare(opts: { householdId: string; authorizedHouseholds: string[]; periods: string[] }): Promise<CareSummaryRow[]> {
    if (!opts.authorizedHouseholds.includes(opts.householdId)) return [];
    if (!opts.periods.length || !opts.periods.every(isPeriod)) return [];
    await this.ensureSchema();
    // The summary is computed by Snowflake; only these aggregate rows come back.
    const rows = await this.sql(
      `SELECT period, category, COUNT(*) AS total,
         COUNT_IF(outcome='taken') AS taken, COUNT_IF(outcome='skipped') AS skipped,
         COUNT_IF(outcome='completed') AS completed, COUNT_IF(outcome='open') AS open_count,
         COUNT_IF(outcome='declined') AS declined, COUNT(DISTINCT occurred_on) AS active_days
       FROM household_care_facts
       WHERE household_id=? AND period IN (${opts.periods.map(() => "?").join(",")})
       GROUP BY period, category
       ORDER BY period DESC, category`,
      [text(opts.householdId), ...opts.periods.map(text)],
    );
    return rows
      .filter((r) => (CARE_FACT_CATEGORIES as readonly string[]).includes(String(r.category)))
      .map((r) => ({
        period: String(r.period),
        category: r.category as CareFactCategory,
        total: Number(r.total),
        outcomes: {
          taken: Number(r.taken),
          skipped: Number(r.skipped),
          completed: Number(r.completed),
          open: Number(r.open_count),
          declined: Number(r.declined),
        },
        activeDays: Number(r.active_days),
      }));
  }
}

const GLOBAL_KEY = "__sahaya_snowflake__";

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function getAnalyticsProvider(): AnalyticsProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as AnalyticsProvider;
  const account = env("SNOWFLAKE_ACCOUNT");
  const token = env("SNOWFLAKE_TOKEN");
  const provider = snowflakeStatus().mode === "live" && account && token
    ? new SnowflakeAnalytics({
        account,
        token,
        tokenType: env("SNOWFLAKE_TOKEN_TYPE"),
        warehouse: env("SNOWFLAKE_WAREHOUSE"),
        database: env("SNOWFLAKE_DATABASE"),
        schema: env("SNOWFLAKE_SCHEMA"),
        role: env("SNOWFLAKE_ROLE"),
      })
    : new SandboxAnalytics();
  g[GLOBAL_KEY] = provider;
  return provider;
}
export function setAnalyticsProvider(p: AnalyticsProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetAnalyticsProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
