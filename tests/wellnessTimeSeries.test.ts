import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import type { BaseAgent } from "@/agents/base/BaseAgent";
import { seedSleepHistory } from "@/agents/wellness/demoHistory";
import { getLongitudinalTrend } from "@/agents/wellness/longitudinalTrends";
import { syncWellnessTimeSeries, toSeriesPoint } from "@/agents/wellness/timeSeriesSync";
import { runWellnessTurn } from "@/agents/wellness/wellnessWorkflow";
import { activeObservations, correctObservation, deleteObservation, saveObservation } from "@/agents/wellness/wellnessStore";
import type { CanonicalObservation } from "@/agents/wellness/observationSchema";
import {
  aggregatePoints,
  bucketStartOf,
  getTimeSeriesProvider,
  resetTimeSeriesProvider,
  setTimeSeriesProvider,
  type SeriesPoint,
  type TimeSeriesProvider,
} from "@/integrations/tigerdata";
import { resetAnalyticsProvider } from "@/integrations/snowflake";
import { resetPersonalMemoryProvider } from "@/integrations/moss";
import { resetHistoricalContextProvider } from "@/integrations/backboard";
import { resetWellnessInferenceProvider } from "@/integrations/bitdeer";

const DAY = 86_400_000;
const TZ = "America/Los_Angeles";
/** Thursday 2026-10-22, 20:00 in Los Angeles. */
const NOW = Date.UTC(2026, 9, 23, 3, 0);

async function wellnessFor(userId = "margaret"): Promise<BaseAgent> {
  const agent = createAgent("wellness", { data: createInMemoryDataLayer(), userId, consent: DEFAULT_CONSENT });
  await agent.initialize();
  return agent;
}

function sleepObs(hours: number, at: number, extra: Partial<CanonicalObservation> = {}): CanonicalObservation {
  return {
    id: `obs-${hours}-${at}`,
    type: "sleep_duration",
    value: hours,
    unit: "hours",
    source: "self_report",
    requiresConfirmation: false,
    evidence: `I slept ${hours} hours.`,
    provenance: { provider: "test", model: "test", mode: "sandbox", extractedAt: at },
    ...extra,
  };
}

function point(value: number, observedAt: number, userId = "margaret"): SeriesPoint {
  return { observationId: `p-${value}-${observedAt}-${userId}`, userId, metric: "sleep", value, unit: "hours", observedAt, recordedAt: observedAt, source: "self_report" };
}

afterEach(() => {
  resetTimeSeriesProvider();
  resetAnalyticsProvider();
  resetPersonalMemoryProvider();
  resetHistoricalContextProvider();
  resetWellnessInferenceProvider();
});

describe("aggregation (reference implementation shared with the Tiger Data SQL path)", () => {
  it("computes weekly averages with counts and never zero-fills missing weeks", () => {
    const monday = bucketStartOf(NOW, "weekly", TZ) + 12 * 3_600_000;
    const pts = [
      point(7, monday - 21 * DAY), point(8, monday - 20 * DAY), point(6, monday - 19 * DAY),
      // (the week of monday - 14 has no reports)
      point(5, monday - 7 * DAY), point(6, monday - 6 * DAY),
    ];
    const buckets = aggregatePoints(pts, { metric: "sleep", granularity: "weekly", timezone: TZ });
    expect(buckets.map((b) => [b.average, b.count])).toEqual([[7, 3], [5.5, 2]]);
    expect(buckets[0].insufficient).toBe(false);
    expect(buckets[1].insufficient).toBe(true);
    expect(buckets[0].stddev).toBe(1);
  });

  it("buckets by the person's LOCAL calendar week, not UTC", () => {
    // Monday 2026-10-19 03:00 UTC is still Sunday evening in Los Angeles, Monday in Tokyo.
    const instant = Date.UTC(2026, 9, 19, 3, 0);
    expect(new Date(bucketStartOf(instant, "weekly", TZ)).toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(new Date(bucketStartOf(instant, "weekly", "Asia/Tokyo")).toISOString().slice(0, 10)).toBe("2026-10-19");
    expect(new Date(bucketStartOf(instant, "monthly", TZ)).toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("keeps users isolated", async () => {
    const ts = getTimeSeriesProvider();
    await ts.upsert([point(7, NOW - DAY, "margaret"), point(2, NOW - DAY, "someone-else")]);
    const b = await ts.aggregate({ userId: "margaret", metric: "sleep", granularity: "weekly", timezone: TZ });
    expect(b).toHaveLength(1);
    expect(b[0].average).toBe(7);
  });
});

describe("Convex -> Tiger Data sync job", () => {
  it("mirrors approved numeric observations only, idempotently", async () => {
    const w = await wellnessFor();
    await saveObservation(w.memory, sleepObs(7, NOW - 2 * DAY));
    await saveObservation(w.memory, sleepObs(3, NOW - DAY, { requiresConfirmation: true }));
    await saveObservation(w.memory, { ...sleepObs(0, NOW - DAY), type: "mood", value: undefined, unit: undefined, description: "felt lonely" });

    const first = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    expect(first).toMatchObject({ ok: true, inserted: 1, skipped: 2 });
    const again = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("propagates corrections and deletions to the SAME mirror (no provider reset)", async () => {
    const w = await wellnessFor();
    const { stored } = await saveObservation(w.memory, sleepObs(4, NOW - DAY));
    await saveObservation(w.memory, sleepObs(8, NOW - 2 * DAY));
    await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const ts = getTimeSeriesProvider();

    await correctObservation(w.memory, stored.recordId, { value: 5 });
    const corr = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    expect(corr.updated).toBe(1);
    expect((await ts.points({ userId: "margaret" })).map((p) => p.value).sort()).toEqual([5, 8]);

    await deleteObservation(w.memory, stored.recordId);
    const del = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    expect(del.removed).toBe(1);
    expect((await ts.points({ userId: "margaret" })).map((p) => p.value)).toEqual([8]);
  });

  it("purges the mirror when consent is revoked, leaving Convex intact", async () => {
    const w = await wellnessFor();
    await saveObservation(w.memory, sleepObs(7, NOW - DAY));
    await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const run = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: { ...DEFAULT_CONSENT, wellnessTimeSeriesSync: false } });
    expect(run).toMatchObject({ status: "purged_no_consent", removed: 1 });
    expect(await getTimeSeriesProvider().points({ userId: "margaret" })).toHaveLength(0);
    expect(await activeObservations(w.memory)).toHaveLength(1);
  });

  it("reports a Tiger Data outage honestly and never touches Convex", async () => {
    const w = await wellnessFor();
    await saveObservation(w.memory, sleepObs(7, NOW - DAY));
    const down = async () => { throw new Error("down"); };
    const broken: TimeSeriesProvider = {
      backend: "tigerdata",
      async status() { return { backend: "tigerdata" as const, mode: "unavailable" as const, detail: "down" }; },
      upsert: down, remove: down, purgeUser: down, points: down, aggregate: down,
    };
    setTimeSeriesProvider(broken);
    const run = await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    expect(run).toMatchObject({ ok: false, status: "failed", error: "down" });
    const trend = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", now: NOW });
    expect(trend.mode).toBe("unavailable");
    expect(await activeObservations(w.memory)).toHaveLength(1);
  });

  it("converts minutes to hours and derives an energy rating from words", () => {
    const base = { recordId: "r", status: "active" as const, contentHash: "h", version: 1, createdAt: NOW, updatedAt: NOW };
    expect(toSeriesPoint({ ...sleepObs(390, NOW), unit: "minutes", ...base }, "u")?.value).toBe(6.5);
    expect(toSeriesPoint({ ...sleepObs(0, NOW), type: "energy", value: undefined, unit: undefined, description: "felt exhausted", ...base }, "u")).toMatchObject({ metric: "energy", value: 1 });
  });
});

describe("history comparison with evidence and uncertainty", () => {
  async function seeded() {
    const w = await wellnessFor();
    await seedSleepHistory({ memory: w.memory, now: NOW, timezone: TZ });
    await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    return w;
  }

  it("compares this week with the person's own baseline and flags sparse data", async () => {
    const w = await seeded();
    const t = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", now: NOW, timezone: TZ });
    expect(t.buckets.map((b) => b.average)).toEqual([7.1, 6.6, 5.8, 5.25]);
    expect(t.baseline).toMatchObject({ average: 6.5, count: 15, periods: 3 });
    expect(t.comparison.direction).toBe("lower");
    expect(t.uncertainty.confidence).toBe("low"); // only 2 reports this week
    expect(t.uncertainty.reasons.join(" ")).toMatch(/Only 2 reports/);
    expect(t.uncertainty.margin).toBeGreaterThan(0);
    expect(t.evidence).toHaveLength(2);
    expect(t.narrative).toMatch(/not a medical assessment/);
  });

  it("calls a small wobble 'similar', not a change", async () => {
    const w = await wellnessFor();
    const monday = bucketStartOf(NOW, "weekly", TZ) + 12 * 3_600_000;
    const nights = [[7, 7.2, 6.8, 7], [7.1, 6.9, 7, 7.2], [6.8, 7, 7.1]];
    for (const [i, week] of nights.entries()) {
      for (const [d, h] of week.entries()) await saveObservation(w.memory, sleepObs(h, monday - (2 - i) * 7 * DAY + d * DAY));
    }
    await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const t = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", now: NOW, timezone: TZ });
    expect(t.comparison.direction).toBe("similar");
  });

  it("hides source sentences from family unless raw sharing is consented", async () => {
    const w = await seeded();
    const fam = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", now: NOW, timezone: TZ, audience: "family", consent: DEFAULT_CONSENT });
    expect(fam.evidence.length).toBeGreaterThan(0);
    expect(fam.evidence.some((e) => e.quote)).toBe(false);
    const raw = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", now: NOW, timezone: TZ, audience: "family", consent: { ...DEFAULT_CONSENT, caregiverWellnessRaw: true } });
    expect(raw.evidence.every((e) => e.quote)).toBe(true);
  });

  it("supports monthly granularity", async () => {
    const w = await seeded();
    const t = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep", granularity: "monthly", now: NOW, timezone: TZ });
    expect(t.buckets.map((b) => b.label)).toEqual(["September 2026", "October 2026"]);
    expect(t.buckets.reduce((s, b) => s + b.count, 0)).toBe(17);
  });
});

describe("demo: a conversational observation updates the multi-week trend", () => {
  it("moves this week's average and count after Margaret mentions last night's sleep", async () => {
    const w = await wellnessFor();
    await seedSleepHistory({ memory: w.memory });
    await syncWellnessTimeSeries({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const before = await getLongitudinalTrend({ memory: w.memory, userId: "margaret", metric: "sleep" });

    const turn = await runWellnessTurn({
      text: "I haven't been sleeping well. I only slept about four hours last night.",
      memory: w.memory,
      userId: "margaret",
      consent: DEFAULT_CONSENT,
    });
    const after = turn.sleepHistory!;
    const beforeCount = before.current && !before.currentIsStale ? before.current.count : 0;
    expect(after.current!.count).toBe(beforeCount + 1);
    expect(after.evidence[0]).toMatchObject({ value: 4, quote: "I only slept about four hours last night." });
    expect(after.comparison.direction).toBe("lower");
    expect(turn.followUp).toMatch(/usual/);
    expect(turn.followUp.toLowerCase()).not.toMatch(/insomnia|depress|diagnos/);
  });
});
