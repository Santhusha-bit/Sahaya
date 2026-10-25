/**
 * Tiger Data — wellness time series (Part 5, Track B, steps 7-8).
 *
 * Tiger Data (TimescaleDB) stores longitudinal sleep/energy points and computes
 * trends. Points are keyed by their source observation id, so re-syncing the same
 * observation is idempotent — a duplicate observation can never inflate a trend
 * (red-team cases 17, 30). Deleted observations are never synced (the caller feeds
 * only canonical ACTIVE observations), so a deleted point can't resurface (case 29).
 *
 * Live with TIGERDATA_URL + TIGERDATA_API_KEY (HTTP SQL gateway); otherwise an
 * in-process sandbox with the same interface. Scoped to one userId.
 */

import { tigerDataStatus } from "@/lib/env";

export interface SeriesPoint {
  observationId: string;
  userId: string;
  metric: "sleep" | "energy";
  value: number;
  unit: string;
  at: number;
}

export interface Trend {
  metric: "sleep" | "energy";
  count: number;
  average: number | null;
  latest: number | null;
  /** Simple direction over the window: improving / declining / stable / n/a. */
  direction: "improving" | "declining" | "stable" | "insufficient_data";
  points: { value: number; at: number }[];
}

export interface TimeSeriesProvider {
  readonly backend: "tigerdata" | "sandbox";
  /** Idempotent on observationId. Returns true if a new point was written. */
  append(point: SeriesPoint): Promise<boolean>;
  range(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number; to?: number }): Promise<SeriesPoint[]>;
  trend(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number }): Promise<Trend>;
}

/** Higher = better for the metric. For sleep, more hours (toward ~8) is better. */
function computeDirection(points: { value: number; at: number }[], metric: "sleep" | "energy"): Trend["direction"] {
  if (points.length < 2) return "insufficient_data";
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);
  const avg = (xs: { value: number }[]) => xs.reduce((s, x) => s + x.value, 0) / xs.length;
  const delta = avg(secondHalf) - avg(firstHalf);
  const threshold = metric === "sleep" ? 0.5 : 0.3; // hours / energy units
  if (Math.abs(delta) < threshold) return "stable";
  return delta > 0 ? "improving" : "declining";
}

export class SandboxTimeSeries implements TimeSeriesProvider {
  readonly backend = "sandbox" as const;
  private points: SeriesPoint[] = [];

  async append(point: SeriesPoint): Promise<boolean> {
    if (this.points.some((p) => p.observationId === point.observationId)) return false; // idempotent
    this.points.push(point);
    return true;
  }
  async range(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number; to?: number }): Promise<SeriesPoint[]> {
    return this.points
      .filter((p) => p.userId === opts.userId && p.metric === opts.metric)
      .filter((p) => (opts.from ? p.at >= opts.from : true) && (opts.to ? p.at <= opts.to : true))
      .sort((a, b) => a.at - b.at);
  }
  async trend(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number }): Promise<Trend> {
    const pts = await this.range(opts);
    const values = pts.map((p) => ({ value: p.value, at: p.at }));
    const average = values.length ? values.reduce((s, v) => s + v.value, 0) / values.length : null;
    return {
      metric: opts.metric,
      count: values.length,
      average: average === null ? null : Math.round(average * 10) / 10,
      latest: values.length ? values[values.length - 1].value : null,
      direction: computeDirection(values, opts.metric),
      points: values,
    };
  }
}

export class TigerDataTimeSeries implements TimeSeriesProvider {
  readonly backend = "tigerdata" as const;
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}
  private async sql(statement: string, params: unknown[]): Promise<unknown[]> {
    const res = await fetch(`${this.url.replace(/\/$/, "")}/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ statement, params }),
    });
    if (!res.ok) throw new Error(`Tiger Data query failed: ${res.status}`);
    const data = (await res.json()) as { rows?: unknown[] };
    return data.rows ?? [];
  }
  async append(point: SeriesPoint): Promise<boolean> {
    const rows = await this.sql(
      "INSERT INTO wellness_series (observation_id, user_id, metric, value, unit, at) VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000)) ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id",
      [point.observationId, point.userId, point.metric, point.value, point.unit, point.at],
    );
    return rows.length > 0;
  }
  async range(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number; to?: number }): Promise<SeriesPoint[]> {
    const rows = (await this.sql(
      "SELECT observation_id, user_id, metric, value, unit, extract(epoch from at)*1000 as at FROM wellness_series WHERE user_id=$1 AND metric=$2 ORDER BY at ASC",
      [opts.userId, opts.metric],
    )) as SeriesPoint[];
    return rows.filter((r) => r.userId === opts.userId);
  }
  async trend(opts: { userId: string; metric: SeriesPoint["metric"]; from?: number }): Promise<Trend> {
    const pts = await this.range(opts);
    const values = pts.map((p) => ({ value: Number(p.value), at: Number(p.at) }));
    const average = values.length ? values.reduce((s, v) => s + v.value, 0) / values.length : null;
    return {
      metric: opts.metric,
      count: values.length,
      average: average === null ? null : Math.round(average * 10) / 10,
      latest: values.length ? values[values.length - 1].value : null,
      direction: computeDirection(values, opts.metric),
      points: values,
    };
  }
}

const GLOBAL_KEY = "__Sahaya_tigerdata__";

export function getTimeSeriesProvider(): TimeSeriesProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as TimeSeriesProvider;
  const provider = tigerDataStatus().mode === "live" && process.env.TIGERDATA_URL && process.env.TIGERDATA_API_KEY
    ? new TigerDataTimeSeries(process.env.TIGERDATA_URL, process.env.TIGERDATA_API_KEY)
    : new SandboxTimeSeries();
  g[GLOBAL_KEY] = provider;
  return provider;
}
export function setTimeSeriesProvider(p: TimeSeriesProvider): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = p;
}
export function resetTimeSeriesProvider(): void {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}
