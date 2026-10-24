/**
 * Snowflake — authorized household analytics (Part 5, Track B, steps 10-11).
 *
 * Snowflake receives ONLY de-identified numeric aggregates for a household (e.g.
 * average sleep this month, number of check-ins) — never raw conversations or
 * individual observations. The type itself carries no free text, so a raw
 * conversation cannot be published here (defends cases 20, 22).
 *
 * Enforcement built into this layer:
 *   - idempotent publish on (householdId, period, metric): a repeated sync does
 *     not create duplicate analytics rows (case 30).
 *   - query is scoped to the requester's authorized households: a caregiver can
 *     never read another household's analytics (cases 19).
 *   - withdraw() removes aggregates when consent is revoked, and queries exclude
 *     withdrawn rows, so revoked data stops appearing in analytics (case 21).
 *
 * Live with SNOWFLAKE_ACCOUNT + SNOWFLAKE_TOKEN (SQL REST API); otherwise an
 * in-process sandbox with the same interface.
 */

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

export interface AnalyticsProvider {
  readonly backend: "snowflake" | "sandbox";
  /** Idempotent on (householdId, period, metric): updates in place, never duplicates. */
  publish(agg: PublishInput): Promise<{ written: boolean; record: HouseholdAggregate }>;
  /** Scoped to authorized households. Excludes withdrawn rows. */
  query(opts: { householdId: string; authorizedHouseholds: string[]; limit?: number }): Promise<HouseholdAggregate[]>;
  /** Withdraw aggregates on consent revocation. Returns count withdrawn. */
  withdraw(opts: { householdId: string; period?: string }): Promise<number>;
}

function key(a: { householdId: string; period: string; metric: string }): string {
  return `${a.householdId}|${a.period}|${a.metric}`;
}

export class SandboxAnalytics implements AnalyticsProvider {
  readonly backend = "sandbox" as const;
  private rows = new Map<string, HouseholdAggregate>();

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
}

export class SnowflakeAnalytics implements AnalyticsProvider {
  readonly backend = "snowflake" as const;
  constructor(
    private readonly account: string,
    private readonly token: string,
  ) {}
  private async sql(statement: string, bindings: unknown[]): Promise<Record<string, unknown>[]> {
    const res = await fetch(`https://${this.account}.snowflakecomputing.com/api/v2/statements`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ statement, bindings: Object.fromEntries(bindings.map((v, i) => [String(i + 1), { type: "TEXT", value: String(v) }])) }),
    });
    if (!res.ok) throw new Error(`Snowflake query failed: ${res.status}`);
    const data = (await res.json()) as { data?: Record<string, unknown>[] };
    return data.data ?? [];
  }
  async publish(agg: PublishInput): Promise<{ written: boolean; record: HouseholdAggregate }> {
    await this.sql(
      "MERGE INTO household_analytics t USING (SELECT ? hh, ? period, ? metric, ? value, ? cnt) s ON t.household_id=s.hh AND t.period=s.period AND t.metric=s.metric WHEN MATCHED THEN UPDATE SET value=s.value, observation_count=s.cnt, withdrawn=FALSE WHEN NOT MATCHED THEN INSERT (household_id, period, metric, value, observation_count) VALUES (s.hh, s.period, s.metric, s.value, s.cnt)",
      [agg.householdId, agg.period, agg.metric, agg.value, agg.observationCount],
    );
    return { written: true, record: { id: id("sf"), ...agg, generatedAt: now() } };
  }
  async query(opts: { householdId: string; authorizedHouseholds: string[]; limit?: number }): Promise<HouseholdAggregate[]> {
    if (!opts.authorizedHouseholds.includes(opts.householdId)) return [];
    const rows = await this.sql(
      "SELECT household_id, period, metric, value, observation_count FROM household_analytics WHERE household_id=? AND withdrawn=FALSE ORDER BY period DESC",
      [opts.householdId],
    );
    return rows.map((r) => ({
      id: id("sf"), householdId: String(r.household_id), period: String(r.period),
      metric: r.metric as AggregateMetric, value: Number(r.value), observationCount: Number(r.observation_count), generatedAt: now(),
    }));
  }
  async withdraw(opts: { householdId: string; period?: string }): Promise<number> {
    const rows = await this.sql(
      `UPDATE household_analytics SET withdrawn=TRUE WHERE household_id=?${opts.period ? " AND period=?" : ""}`,
      opts.period ? [opts.householdId, opts.period] : [opts.householdId],
    );
    return rows.length;
  }
}

const GLOBAL_KEY = "__kinline_snowflake__";

export function getAnalyticsProvider(): AnalyticsProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as AnalyticsProvider;
  const provider = snowflakeStatus().mode === "live" && process.env.SNOWFLAKE_ACCOUNT && process.env.SNOWFLAKE_TOKEN
    ? new SnowflakeAnalytics(process.env.SNOWFLAKE_ACCOUNT, process.env.SNOWFLAKE_TOKEN)
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
