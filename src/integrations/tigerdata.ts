/**
 * Tiger Data: longitudinal wellness time series.
 *
 * Convex (the Wellness agent's scoped memory) stays the canonical store for
 * every observation. Tiger Data is a NUMERIC ANALYTICS MIRROR: the sync job
 * (src/agents/wellness/timeSeriesSync.ts) writes approved numeric observations
 * here, and Sahaya queries weekly / monthly aggregates back. Raw conversation
 * text is never written to this store, only the narrow record below.
 *
 * Two backends behind one interface:
 *   - TigerDataTimeSeries: real Tiger Data (TimescaleDB on PostgreSQL). Connects
 *     with a standard postgres:// service URL via `pg`, stores points in a
 *     hypertable, and computes aggregates IN THE DATABASE with `time_bucket`.
 *   - SandboxTimeSeries: in-process, computing identical aggregates with the
 *     pure `aggregatePoints` reference implementation below.
 *
 * Every point is keyed by its canonical observation id, so re-syncing is
 * idempotent (a duplicate can never inflate a trend, red-team cases 17, 30) and
 * the sync job can remove points whose canonical record was deleted (case 29)
 * or update points whose canonical record was corrected.
 */

import { tigerDataServiceUrl, tigerDataStatus } from "@/lib/env";

export type WellnessMetric = "sleep" | "energy";
export const WELLNESS_METRICS: WellnessMetric[] = ["sleep", "energy"];

export const METRIC_UNIT: Record<WellnessMetric, string> = { sleep: "hours", energy: "rating" };
export const METRIC_LABEL: Record<WellnessMetric, string> = { sleep: "Sleep", energy: "Energy" };

export type Granularity = "weekly" | "monthly";

/** The exact record mirrored into Tiger Data. Timestamps are UTC epoch ms. */
export interface SeriesPoint {
  observationId: string;
  userId: string;
  metric: WellnessMetric;
  value: number;
  unit: string;
  /** When the reported thing happened. */
  observedAt: number;
  /** When the canonical record was last written (changes on correction). */
  recordedAt: number;
  source: string;
}

/** One aggregated calendar bucket. Missing periods are absent, never zero-filled. */
export interface AggregateBucket {
  metric: WellnessMetric;
  granularity: Granularity;
  /** UTC midnight of the bucket's first LOCAL calendar day (stable label anchor). */
  bucketStart: number;
  label: string;
  count: number;
  average: number;
  min: number;
  max: number;
  /** Sample standard deviation (null when count < 2). */
  stddev: number | null;
  unit: string;
  /** Too few observations back this bucket for it to mean much. */
  insufficient: boolean;
}

export interface AggregateQuery {
  userId: string;
  metric: WellnessMetric;
  granularity: Granularity;
  from?: number;
  to?: number;
  /** IANA timezone used to align calendar buckets. */
  timezone: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface ProviderStatus {
  backend: "tigerdata" | "sandbox";
  mode: "live" | "sandbox" | "unavailable";
  detail: string;
}

/** Simple point-level summary kept for the per-turn follow-up and red-team checks. */
export interface Trend {
  metric: WellnessMetric;
  count: number;
  average: number | null;
  latest: number | null;
  direction: "improving" | "declining" | "stable" | "insufficient_data";
  points: { value: number; at: number }[];
}

export interface TimeSeriesProvider {
  readonly backend: "tigerdata" | "sandbox";
  status(): Promise<ProviderStatus>;
  /** Idempotent on observationId: same value+time is a no-op, a change updates. */
  upsert(points: SeriesPoint[]): Promise<UpsertResult>;
  /** Remove specific points (deletion propagation). Returns rows removed. */
  remove(userId: string, observationIds: string[]): Promise<number>;
  /** Remove ALL of a user's points (consent revocation). */
  purgeUser(userId: string): Promise<number>;
  /** Raw points for one user + metric, oldest first. */
  points(opts: { userId: string; metric?: WellnessMetric; from?: number; to?: number }): Promise<SeriesPoint[]>;
  /** Weekly / monthly aggregates, oldest first. */
  aggregate(query: AggregateQuery): Promise<AggregateBucket[]>;
}

// ---------------------------------------------------------------------------
// Pure reference aggregation (the sandbox uses it; the SQL path must agree).
// ---------------------------------------------------------------------------

/** Minimum observations before a bucket is considered meaningful. */
export const MIN_OBSERVATIONS: Record<Granularity, number> = { weekly: 3, monthly: 7 };

const DAY = 86_400_000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Timezone-local calendar parts for an instant (DST-safe via Intl). */
export function zonedParts(epoch: number, timezone: string): { year: number; month: number; day: number; weekdayMon0: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(epoch));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekdayMon0: weekday[get("weekday")] ?? 0 };
}

/**
 * Bucket anchor for an instant: the local calendar date of the bucket's first
 * day (Monday for weeks, the 1st for months) expressed as UTC midnight. Both
 * backends use this convention so their bucketStart values compare equal.
 */
export function bucketStartOf(epoch: number, granularity: Granularity, timezone: string): number {
  const { year, month, day, weekdayMon0 } = zonedParts(epoch, timezone);
  if (granularity === "monthly") return Date.UTC(year, month - 1, 1);
  return Date.UTC(year, month - 1, day) - weekdayMon0 * DAY;
}

export function bucketLabel(start: number, granularity: Granularity): string {
  const d = new Date(start);
  if (granularity === "monthly") {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(d);
  }
  return `Week of ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(d)}`;
}

function stddevOf(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return round2(Math.sqrt(variance));
}

export function makeBucket(metric: WellnessMetric, granularity: Granularity, start: number, values: number[]): AggregateBucket {
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    metric,
    granularity,
    bucketStart: start,
    label: bucketLabel(start, granularity),
    count,
    average: round2(sum / count),
    min: Math.min(...values),
    max: Math.max(...values),
    stddev: stddevOf(values),
    unit: METRIC_UNIT[metric],
    insufficient: count < MIN_OBSERVATIONS[granularity],
  };
}

export function aggregatePoints(points: SeriesPoint[], q: Omit<AggregateQuery, "userId">): AggregateBucket[] {
  const groups = new Map<number, number[]>();
  for (const p of points) {
    if (p.metric !== q.metric) continue;
    if (q.from != null && p.observedAt < q.from) continue;
    if (q.to != null && p.observedAt > q.to) continue;
    const start = bucketStartOf(p.observedAt, q.granularity, q.timezone);
    const g = groups.get(start) ?? [];
    g.push(p.value);
    groups.set(start, g);
  }
  return [...groups.entries()]
    .map(([start, values]) => makeBucket(q.metric, q.granularity, start, values))
    .sort((a, b) => a.bucketStart - b.bucketStart);
}

/** Higher = better for both metrics. Compares the first and second half of the points. */
export function computeTrend(points: SeriesPoint[], metric: WellnessMetric): Trend {
  const values = points
    .filter((p) => p.metric === metric)
    .sort((a, b) => a.observedAt - b.observedAt)
    .map((p) => ({ value: p.value, at: p.observedAt }));
  const average = values.length ? Math.round((values.reduce((s, v) => s + v.value, 0) / values.length) * 10) / 10 : null;
  let direction: Trend["direction"] = "insufficient_data";
  if (values.length >= 2) {
    const mid = Math.floor(values.length / 2);
    const avg = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0) / xs.length;
    const delta = avg(values.slice(mid)) - avg(values.slice(0, mid));
    const threshold = metric === "sleep" ? 0.5 : 0.3;
    direction = Math.abs(delta) < threshold ? "stable" : delta > 0 ? "improving" : "declining";
  }
  return { metric, count: values.length, average, latest: values.length ? values[values.length - 1].value : null, direction, points: values };
}

export function emptyTrend(metric: WellnessMetric): Trend {
  return { metric, count: 0, average: null, latest: null, direction: "insufficient_data", points: [] };
}

// ---------------------------------------------------------------------------
// Sandbox backend
// ---------------------------------------------------------------------------

export class SandboxTimeSeries implements TimeSeriesProvider {
  readonly backend = "sandbox" as const;
  private rows = new Map<string, SeriesPoint>();

  async status(): Promise<ProviderStatus> {
    return { backend: "sandbox", mode: "sandbox", detail: tigerDataStatus().detail };
  }

  async upsert(points: SeriesPoint[]): Promise<UpsertResult> {
    const r: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
    for (const p of points) {
      const prior = this.rows.get(p.observationId);
      if (!prior) r.inserted++;
      else if (prior.value !== p.value || prior.observedAt !== p.observedAt || prior.userId !== p.userId) r.updated++;
      else {
        r.unchanged++;
        continue;
      }
      this.rows.set(p.observationId, { ...p });
    }
    return r;
  }

  async remove(userId: string, observationIds: string[]): Promise<number> {
    let n = 0;
    for (const id of observationIds) {
      if (this.rows.get(id)?.userId === userId && this.rows.delete(id)) n++;
    }
    return n;
  }

  async purgeUser(userId: string): Promise<number> {
    const ids = [...this.rows.values()].filter((p) => p.userId === userId).map((p) => p.observationId);
    return this.remove(userId, ids);
  }

  async points(opts: { userId: string; metric?: WellnessMetric; from?: number; to?: number }): Promise<SeriesPoint[]> {
    return [...this.rows.values()]
      .filter((p) => p.userId === opts.userId && (!opts.metric || p.metric === opts.metric))
      .filter((p) => (opts.from == null || p.observedAt >= opts.from) && (opts.to == null || p.observedAt <= opts.to))
      .sort((a, b) => a.observedAt - b.observedAt)
      .map((p) => ({ ...p }));
  }

  async aggregate(q: AggregateQuery): Promise<AggregateBucket[]> {
    return aggregatePoints(await this.points({ userId: q.userId, metric: q.metric }), q);
  }
}

// ---------------------------------------------------------------------------
// Real Tiger Data backend (TimescaleDB on PostgreSQL)
// ---------------------------------------------------------------------------

const TABLE = "wellness_series";
const INTERVAL: Record<Granularity, string> = { weekly: "1 week", monthly: "1 month" };

type PgPool = import("pg").Pool;

export class TigerDataTimeSeries implements TimeSeriesProvider {
  readonly backend = "tigerdata" as const;
  private pool: PgPool | null = null;
  private ready: Promise<void> | null = null;

  constructor(private readonly connectionString: string) {}

  private async db(): Promise<PgPool> {
    if (!this.pool) {
      const pg = await import("pg");
      const Pool = pg.Pool ?? (pg as unknown as { default: typeof pg }).default.Pool;
      this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    }
    this.ready ??= this.ensureSchema(this.pool).catch((err) => {
      this.ready = null; // retry schema setup on the next call
      throw err;
    });
    await this.ready;
    return this.pool;
  }

  private async ensureSchema(pool: PgPool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        observation_id TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        metric         TEXT NOT NULL,
        value          DOUBLE PRECISION NOT NULL,
        unit           TEXT NOT NULL,
        observed_at    TIMESTAMPTZ NOT NULL,
        recorded_at    TIMESTAMPTZ NOT NULL,
        source         TEXT NOT NULL,
        PRIMARY KEY (observation_id, observed_at)
      );`);
    // Hypertable partitioned on time. Tiger Data services ship the extension.
    try {
      await pool.query(`SELECT create_hypertable('${TABLE}', by_range('observed_at'), if_not_exists => TRUE, migrate_data => TRUE);`);
    } catch {
      // TimescaleDB < 2.13 only has the older signature.
      await pool.query(`SELECT create_hypertable('${TABLE}', 'observed_at', if_not_exists => TRUE, migrate_data => TRUE);`);
    }
    await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_user_metric_idx ON ${TABLE} (user_id, metric, observed_at DESC);`);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const pool = await this.db();
      const r = await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'");
      const v = r.rows[0]?.extversion as string | undefined;
      return {
        backend: "tigerdata",
        mode: v ? "live" : "unavailable",
        detail: v
          ? `Live: Tiger Data (TimescaleDB ${v}). Weekly/monthly aggregates computed with time_bucket.`
          : "Unavailable: PostgreSQL connected but the TimescaleDB extension is missing.",
      };
    } catch (err) {
      return { backend: "tigerdata", mode: "unavailable", detail: `Unavailable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async upsert(points: SeriesPoint[]): Promise<UpsertResult> {
    const r: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
    if (!points.length) return r;
    const pool = await this.db();
    const existing = await pool.query(
      `SELECT observation_id, value, (extract(epoch FROM observed_at) * 1000)::bigint AS observed_ms
         FROM ${TABLE} WHERE observation_id = ANY($1::text[])`,
      [points.map((p) => p.observationId)],
    );
    const prior = new Map<string, { value: number; observedMs: number }>(
      existing.rows.map((row) => [row.observation_id as string, { value: Number(row.value), observedMs: Number(row.observed_ms) }]),
    );
    const toWrite = points.filter((p) => {
      const old = prior.get(p.observationId);
      if (!old) r.inserted++;
      else if (old.value !== p.value || old.observedMs !== p.observedAt) r.updated++;
      else {
        r.unchanged++;
        return false;
      }
      return true;
    });
    if (!toWrite.length) return r;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Delete-then-insert handles value AND timestamp corrections uniformly
      // (a changed observed_at moves the row to a different hypertable chunk).
      await client.query(`DELETE FROM ${TABLE} WHERE observation_id = ANY($1::text[])`, [toWrite.map((p) => p.observationId)]);
      for (const p of toWrite) {
        await client.query(
          `INSERT INTO ${TABLE} (observation_id, user_id, metric, value, unit, observed_at, recorded_at, source)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8)`,
          [p.observationId, p.userId, p.metric, p.value, p.unit, p.observedAt, p.recordedAt, p.source],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return r;
  }

  async remove(userId: string, observationIds: string[]): Promise<number> {
    if (!observationIds.length) return 0;
    const pool = await this.db();
    const r = await pool.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND observation_id = ANY($2::text[])`, [userId, observationIds]);
    return r.rowCount ?? 0;
  }

  async purgeUser(userId: string): Promise<number> {
    const pool = await this.db();
    const r = await pool.query(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId]);
    return r.rowCount ?? 0;
  }

  async points(opts: { userId: string; metric?: WellnessMetric; from?: number; to?: number }): Promise<SeriesPoint[]> {
    const pool = await this.db();
    const r = await pool.query(
      `SELECT observation_id, user_id, metric, value, unit, source,
              (extract(epoch FROM observed_at) * 1000)::bigint AS observed_ms,
              (extract(epoch FROM recorded_at) * 1000)::bigint AS recorded_ms
         FROM ${TABLE}
        WHERE user_id = $1
          AND ($2::text IS NULL OR metric = $2)
          AND ($3::timestamptz IS NULL OR observed_at >= $3)
          AND ($4::timestamptz IS NULL OR observed_at <= $4)
        ORDER BY observed_at ASC`,
      [opts.userId, opts.metric ?? null, opts.from != null ? new Date(opts.from) : null, opts.to != null ? new Date(opts.to) : null],
    );
    return r.rows.map((row) => ({
      observationId: row.observation_id,
      userId: row.user_id,
      metric: row.metric,
      value: Number(row.value),
      unit: row.unit,
      observedAt: Number(row.observed_ms),
      recordedAt: Number(row.recorded_ms),
      source: row.source,
    }));
  }

  async aggregate(q: AggregateQuery): Promise<AggregateBucket[]> {
    const pool = await this.db();
    // time_bucket with a timezone aligns buckets to LOCAL midnight (weeks start
    // Monday). We return the bucket's local calendar date so bucketStart uses
    // the same UTC-midnight anchor as the sandbox reference implementation.
    const r = await pool.query(
      `SELECT to_char(time_bucket(INTERVAL '${INTERVAL[q.granularity]}', observed_at, $3) AT TIME ZONE $3, 'YYYY-MM-DD') AS bucket_day,
              count(*)::int AS n,
              avg(value) AS average,
              min(value) AS min,
              max(value) AS max,
              stddev_samp(value) AS stddev
         FROM ${TABLE}
        WHERE user_id = $1 AND metric = $2
          AND ($4::timestamptz IS NULL OR observed_at >= $4)
          AND ($5::timestamptz IS NULL OR observed_at <= $5)
        GROUP BY bucket_day
        ORDER BY bucket_day`,
      [q.userId, q.metric, q.timezone, q.from != null ? new Date(q.from) : null, q.to != null ? new Date(q.to) : null],
    );
    return r.rows.map((row): AggregateBucket => {
      const [y, m, d] = String(row.bucket_day).split("-").map(Number);
      const start = Date.UTC(y, m - 1, d);
      const count = Number(row.n);
      return {
        metric: q.metric,
        granularity: q.granularity,
        bucketStart: start,
        label: bucketLabel(start, q.granularity),
        count,
        average: round2(Number(row.average)),
        min: Number(row.min),
        max: Number(row.max),
        stddev: row.stddev == null ? null : round2(Number(row.stddev)),
        unit: METRIC_UNIT[q.metric],
        insufficient: count < MIN_OBSERVATIONS[q.granularity],
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__sahaya_tigerdata__";

export function getTimeSeriesProvider(): TimeSeriesProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as TimeSeriesProvider;
  const url = tigerDataServiceUrl();
  const provider = url ? new TigerDataTimeSeries(url) : new SandboxTimeSeries();
  g[GLOBAL_KEY] = provider;
  return provider;
}
export function setTimeSeriesProvider(p: TimeSeriesProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetTimeSeriesProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
