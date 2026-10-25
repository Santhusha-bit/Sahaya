/**
 * Longitudinal wellness trends: compare the current period with the person's
 * own history, with evidence and uncertainty attached.
 *
 * Aggregates come from the time-series provider (Tiger Data `time_bucket` when
 * live). The comparison is deliberately conservative and descriptive:
 *
 *   - Baseline = the person's earlier periods in the window, not a population norm.
 *   - A difference is only called "lower"/"higher" when it is both practically
 *     meaningful (>= 0.5 h of sleep / 0.5 rating points) AND larger than the
 *     noise in their reports (95% interval on the difference). Otherwise it is
 *     "similar to usual".
 *   - Uncertainty is explicit: a confidence level, a +/- margin, and the plain
 *     reasons (few reports, short history, self-reported, derived rating).
 *   - Evidence lists the canonical observations behind the current period.
 *     Quoted source sentences are shown to the person themself, but to family
 *     only when `caregiverWellnessRaw` consent is on.
 *
 * Nothing here is a medical judgement; the narrative says so.
 */

import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import {
  bucketStartOf,
  getTimeSeriesProvider,
  METRIC_LABEL,
  METRIC_UNIT,
  type AggregateBucket,
  type Granularity,
  type TimeSeriesProvider,
  type WellnessMetric,
} from "@/integrations/tigerdata";
import { now as nowMs } from "@/lib/id";
import { lastSyncRun, type SyncRun } from "./timeSeriesSync";
import { activeObservations } from "./wellnessStore";

export const DEFAULT_TIMEZONE = process.env.SAHAYA_TIMEZONE?.trim() || "America/Los_Angeles";

const DAY = 86_400_000;
/** Smallest difference worth mentioning, per metric. */
const PRACTICAL_DELTA: Record<WellnessMetric, number> = { sleep: 0.5, energy: 0.5 };
const WINDOW: Record<Granularity, number> = { weekly: 8, monthly: 6 };

export type Audience = "self" | "family";

export interface TrendEvidence {
  observationId: string;
  observedAt: number;
  value: number;
  unit: string;
  source: string;
  corrected: boolean;
  /** The sentence the observation was extracted from (audience permitting). */
  quote?: string;
}

export interface LongitudinalTrend {
  metric: WellnessMetric;
  label: string;
  unit: string;
  granularity: Granularity;
  timezone: string;
  backend: "tigerdata" | "sandbox";
  mode: "live" | "sandbox" | "unavailable";
  buckets: AggregateBucket[];
  /** The period being compared: the one containing "now", else the latest reported. */
  current: AggregateBucket | null;
  /** True when nothing has been reported in the period containing "now". */
  currentIsStale: boolean;
  baseline: { average: number | null; stddev: number | null; count: number; periods: number };
  comparison: {
    delta: number | null;
    direction: "lower" | "higher" | "similar" | "insufficient";
  };
  uncertainty: {
    confidence: "low" | "medium" | "high";
    /** +/- 95% margin on the current period's average. */
    margin: number | null;
    reasons: string[];
  };
  evidence: TrendEvidence[];
  totalObservations: number;
  narrative: string;
  lastSync: SyncRun | null;
  generatedAt: number;
  error?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

function fmt(metric: WellnessMetric, v: number): string {
  return metric === "sleep" ? `${round2(v)} hours` : `${round2(v)} out of 5`;
}

function periodWord(g: Granularity): string {
  return g === "weekly" ? "week" : "month";
}

export async function getLongitudinalTrend(opts: {
  memory: ScopedMemory;
  userId: string;
  metric: WellnessMetric;
  granularity?: Granularity;
  timezone?: string;
  audience?: Audience;
  consent?: ConsentSettings;
  now?: number;
  provider?: TimeSeriesProvider;
}): Promise<LongitudinalTrend> {
  const metric = opts.metric;
  const granularity = opts.granularity ?? "weekly";
  const timezone = opts.timezone ?? DEFAULT_TIMEZONE;
  const at = opts.now ?? nowMs();
  const ts = opts.provider ?? getTimeSeriesProvider();
  const includeQuotes = (opts.audience ?? "self") === "self" || opts.consent?.caregiverWellnessRaw === true;

  const currentStart = bucketStartOf(at, granularity, timezone);
  const from =
    granularity === "weekly"
      ? currentStart - (WINDOW.weekly - 1) * 7 * DAY - DAY // a day of slack for timezone offsets
      : Date.UTC(new Date(currentStart).getUTCFullYear(), new Date(currentStart).getUTCMonth() - (WINDOW.monthly - 1), 1) - DAY;

  const base: LongitudinalTrend = {
    metric,
    label: METRIC_LABEL[metric],
    unit: METRIC_UNIT[metric],
    granularity,
    timezone,
    backend: ts.backend,
    mode: ts.backend === "tigerdata" ? "live" : "sandbox",
    buckets: [],
    current: null,
    currentIsStale: false,
    baseline: { average: null, stddev: null, count: 0, periods: 0 },
    comparison: { delta: null, direction: "insufficient" },
    uncertainty: { confidence: "low", margin: null, reasons: [] },
    evidence: [],
    totalObservations: 0,
    narrative: "",
    lastSync: await lastSyncRun(opts.memory).catch(() => null),
    generatedAt: at,
  };

  let buckets: AggregateBucket[];
  let points: Awaited<ReturnType<TimeSeriesProvider["points"]>>;
  try {
    [buckets, points] = await Promise.all([
      ts.aggregate({ userId: opts.userId, metric, granularity, timezone, from, to: at }),
      ts.points({ userId: opts.userId, metric, from, to: at }),
    ]);
  } catch (err) {
    return {
      ...base,
      mode: "unavailable",
      error: err instanceof Error ? err.message : String(err),
      uncertainty: { confidence: "low", margin: null, reasons: ["The time-series store could not be reached, so no trend is shown."] },
      narrative: "Trends are temporarily unavailable. Nothing has been lost: every report is still saved.",
    };
  }
  // Drop the timezone-slack bucket if it falls before the window.
  const firstStart = granularity === "weekly" ? currentStart - (WINDOW.weekly - 1) * 7 * DAY : from + DAY;
  buckets = buckets.filter((b) => b.bucketStart >= firstStart);
  points = points.filter((p) => bucketStartOf(p.observedAt, granularity, timezone) >= firstStart);

  const result: LongitudinalTrend = { ...base, buckets, totalObservations: points.length };
  if (!buckets.length) {
    result.uncertainty.reasons.push(`No ${METRIC_LABEL[metric].toLowerCase()} reports in the last ${WINDOW[granularity]} ${periodWord(granularity)}s.`);
    result.narrative = `There aren't any ${METRIC_LABEL[metric].toLowerCase()} reports yet, so there's no trend to show. Missing days are never counted as zero.`;
    return result;
  }

  const current = buckets.find((b) => b.bucketStart === currentStart) ?? buckets[buckets.length - 1];
  result.current = current;
  result.currentIsStale = current.bucketStart !== currentStart;

  const inCurrent = points.filter((p) => bucketStartOf(p.observedAt, granularity, timezone) === current.bucketStart);
  const inBaseline = points.filter((p) => bucketStartOf(p.observedAt, granularity, timezone) < current.bucketStart);
  const baselineValues = inBaseline.map((p) => p.value);
  const baselinePeriods = buckets.filter((b) => b.bucketStart < current.bucketStart).length;
  result.baseline = {
    average: baselineValues.length ? round2(mean(baselineValues)) : null,
    stddev: sampleSd(baselineValues) === null ? null : round2(sampleSd(baselineValues)!),
    count: baselineValues.length,
    periods: baselinePeriods,
  };

  // Noise estimate: the person's own spread (baseline first, then current period).
  const spread = sampleSd(baselineValues) ?? sampleSd(inCurrent.map((p) => p.value));
  const nc = inCurrent.length;
  const nb = baselineValues.length;
  result.uncertainty.margin = spread !== null && nc > 0 ? round2((1.96 * spread) / Math.sqrt(nc)) : null;

  if (result.baseline.average !== null && nb >= 2) {
    const delta = round2(current.average - result.baseline.average);
    const seDiff = spread !== null ? spread * Math.sqrt(1 / nc + 1 / nb) : Infinity;
    const meaningful = Math.abs(delta) >= PRACTICAL_DELTA[metric] && Math.abs(delta) > 1.96 * seDiff;
    result.comparison = { delta, direction: meaningful ? (delta < 0 ? "lower" : "higher") : "similar" };
  }

  // Confidence + plain-language reasons.
  const reasons = result.uncertainty.reasons;
  if (nc < 3) reasons.push(`Only ${nc} report${nc === 1 ? "" : "s"} so far this ${periodWord(granularity)}.`);
  if (baselinePeriods < 2) reasons.push(`Fewer than 2 earlier ${periodWord(granularity)}s to compare against.`);
  const thin = buckets.filter((b) => b.insufficient).length;
  if (thin && nc >= 3) reasons.push(`${thin} of ${buckets.length} ${periodWord(granularity)}s have too few reports to rely on alone.`);
  if (result.currentIsStale) reasons.push(`Nothing reported yet this ${periodWord(granularity)}; showing the most recent ${periodWord(granularity)} with reports.`);
  reasons.push(metric === "energy" ? "Energy is a coarse rating derived from the words used, not a measurement." : "Sleep hours are self-reported, not measured by a device.");
  const confidence: LongitudinalTrend["uncertainty"]["confidence"] =
    nc >= 5 && nb >= 10 && baselinePeriods >= 3 ? "high" : nc >= 3 && nb >= 6 && baselinePeriods >= 2 ? "medium" : "low";
  result.uncertainty.confidence = metric === "energy" && confidence === "high" ? "medium" : confidence;

  // Evidence: the canonical observations behind the current period.
  const canonical = new Map((await activeObservations(opts.memory)).map((o) => [o.id, o]));
  result.evidence = inCurrent
    .slice()
    .sort((a, b) => b.observedAt - a.observedAt)
    .map((p) => {
      const o = canonical.get(p.observationId);
      return {
        observationId: p.observationId,
        observedAt: p.observedAt,
        value: p.value,
        unit: p.unit,
        source: p.source,
        corrected: !!o?.correctedAt,
        ...(includeQuotes && o?.evidence ? { quote: o.evidence } : {}),
      };
    });

  result.narrative = narrate(result);
  return result;
}

function narrate(t: LongitudinalTrend): string {
  const c = t.current!;
  const word = periodWord(t.granularity);
  const which = t.currentIsStale ? `In the ${c.label.toLowerCase()}` : `This ${word}`;
  const subject = t.metric === "sleep" ? "reported sleep" : "reported energy";
  const head = `${which}, ${subject} averages ${fmt(t.metric, c.average)} across ${c.count} report${c.count === 1 ? "" : "s"}`;
  const caveat = "This describes self-reports only and is not a medical assessment.";
  if (t.comparison.direction === "insufficient" || t.baseline.average === null) {
    return `${head}. There isn't enough earlier history yet to compare against. ${caveat}`;
  }
  const usual = `the usual ${fmt(t.metric, t.baseline.average)} over the previous ${t.baseline.periods} ${word}${t.baseline.periods === 1 ? "" : "s"}`;
  if (t.comparison.direction === "similar") return `${head}, similar to ${usual}. ${caveat}`;
  const gap = round2(Math.abs(t.comparison.delta!));
  const diff = t.metric === "sleep" ? `${gap} hours` : `${gap} rating points`;
  return `${head}, about ${diff} ${t.comparison.direction === "lower" ? "less" : "more"} than ${usual}. ${caveat}`;
}
