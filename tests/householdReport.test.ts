import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import type { DataLayer } from "@/agents/base/types";
import { createAgent } from "@/agents/registry";
import { DEMO_HOUSEHOLD } from "@/agents/wellness/householdAnalytics";
import { requestCareAssistance } from "@/integrations/fetchai";
import {
  SandboxAnalytics,
  SnowflakeAnalytics,
  resetAnalyticsProvider,
  setAnalyticsProvider,
  summarizeCareFacts,
  type CareFact,
} from "@/integrations/snowflake";
import { exportHouseholdCareFacts, periodOf, previousPeriod } from "@/analytics/householdCareExport";
import { getFamilyCareReport } from "@/analytics/familyCareReport";

const USER = "margaret";
const PERIOD = periodOf(Date.now());
const PREV = previousPeriod(PERIOD);
const owner = { role: "caregiver" as const, householdId: DEMO_HOUSEHOLD };

afterEach(() => {
  resetAnalyticsProvider();
  vi.unstubAllGlobals();
});

/** Seeds real Care confirmations and real Care -> Guardian assistance requests. */
async function seed(data: DataLayer) {
  const care = createAgent("care", { data, userId: USER, consent: DEFAULT_CONSENT });
  await care.initialize();
  for (const taken of [true, true, true, false]) {
    await care.executeTool("recordMedicationConfirmation", { medicationName: "Metformin", taken, note: "with breakfast" });
  }
  // Last month: one taken, one skipped (50%).
  const lastMonth = new Date(`${PREV}-15T12:00:00Z`).getTime();
  for (const taken of [true, false]) {
    await data.memory.put({
      id: `mem_prev_${taken}`, namespace: "care", collection: "confirmations", userId: USER,
      data: { medicationName: "Metformin", taken }, createdAt: lastMonth, updatedAt: lastMonth,
    });
  }
  const a = await requestCareAssistance({ data, userId: USER, need: "collect Metformin refill from Elm St pharmacy" });
  await requestCareAssistance({ data, userId: USER, need: "help carrying groceries upstairs" });
  await data.tasks.patch(a.taskId, { status: "completed" });
}

describe("monthly family care summary (Snowflake household analytics)", () => {
  it("exports consented records and reports medication rate and assistance outcomes", async () => {
    const data = createInMemoryDataLayer();
    await seed(data);

    const exp = await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD, PREV] });
    expect(exp.ok).toBe(true);
    expect(exp.mode).toBe("sandbox");

    const res = await getFamilyCareReport({ requester: owner, targetHouseholdId: DEMO_HOUSEHOLD, period: PERIOD, consent: DEFAULT_CONSENT });
    if (!res.ok) throw new Error(res.reason);
    const r = res.report;
    expect(r.medication).toMatchObject({ taken: 3, skipped: 1, rate: 0.75, previousRate: 0.5 });
    expect(r.assistance).toMatchObject({ total: 2, completed: 1, open: 1, declined: 0 });
    expect(r.lines.join(" ")).toMatch(/3 of 4 times \(75%\), up from 50%/);
    expect(r.headline).toMatch(/missed/);
    expect(r.notShared).toEqual([]);
  });

  it("never exports names, notes, request text or user ids", async () => {
    const data = createInMemoryDataLayer();
    await seed(data);
    const sent: CareFact[] = [];
    const sandbox = new SandboxAnalytics();
    const spy = Object.assign(Object.create(sandbox), {
      replaceCareFacts: (opts: Parameters<SandboxAnalytics["replaceCareFacts"]>[0]) => {
        sent.push(...opts.facts);
        return sandbox.replaceCareFacts(opts);
      },
    });
    setAnalyticsProvider(spy);

    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD, PREV] });
    expect(sent.length).toBe(8);
    const blob = JSON.stringify(sent);
    expect(blob).not.toMatch(/Metformin|breakfast|pharmacy|groceries|margaret|mem_|corr_|careassist/i);
    for (const f of sent) {
      expect(Object.keys(f).sort()).toEqual(["category", "factId", "householdId", "occurredOn", "outcome", "period"]);
    }
  });

  it("rejects a fact carrying any extra field", async () => {
    const provider = new SandboxAnalytics();
    const leaky = {
      factId: "a".repeat(24), householdId: DEMO_HOUSEHOLD, period: PERIOD, category: "medication_confirmation",
      outcome: "taken", occurredOn: `${PERIOD}-01`, medicationName: "Metformin",
    } as unknown as CareFact;
    await expect(
      provider.replaceCareFacts({ householdId: DEMO_HOUSEHOLD, category: "medication_confirmation", periods: [PERIOD], facts: [leaky] }),
    ).rejects.toThrow();
  });

  it("refuses another household's report", async () => {
    const data = createInMemoryDataLayer();
    await seed(data);
    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD] });
    const res = await getFamilyCareReport({
      requester: { role: "caregiver", householdId: "other-household" },
      targetHouseholdId: DEMO_HOUSEHOLD,
      period: PERIOD,
      consent: DEFAULT_CONSENT,
    });
    expect(res.ok).toBe(false);
  });

  it("withdraws a category when its consent is revoked", async () => {
    const data = createInMemoryDataLayer();
    await seed(data);
    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD, PREV] });

    const revoked = { ...DEFAULT_CONSENT, householdAnalyticsMedication: false };
    const exp = await exportHouseholdCareFacts({ data, userId: USER, consent: revoked, periods: [PERIOD, PREV] });
    expect(exp.categories.find((c) => c.category === "medication_confirmation")?.withdrawn).toBe(6);

    const res = await getFamilyCareReport({ requester: owner, targetHouseholdId: DEMO_HOUSEHOLD, period: PERIOD, consent: revoked });
    if (!res.ok) throw new Error(res.reason);
    expect(res.report.medication).toBeNull();
    expect(res.report.notShared).toEqual(["Medication confirmations"]);
    expect(res.report.assistance?.total).toBe(2);
  });

  it("re-export is idempotent and reflects deleted source records", async () => {
    const data = createInMemoryDataLayer();
    await seed(data);
    const read = async () => {
      const res = await getFamilyCareReport({ requester: owner, targetHouseholdId: DEMO_HOUSEHOLD, period: PERIOD, consent: DEFAULT_CONSENT });
      if (!res.ok) throw new Error(res.reason);
      return res.report.medication!;
    };
    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD] });
    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD] });
    expect((await read()).taken + (await read()).skipped).toBe(4);

    const [skipped] = (await data.memory.list({ namespace: "care", userId: USER, collection: "confirmations" })).filter(
      (r) => r.data.taken === false && periodOf(r.createdAt) === PERIOD,
    );
    await data.memory.remove(skipped.id);
    await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [PERIOD] });
    expect(await read()).toMatchObject({ taken: 3, skipped: 0, rate: 1 });
  });

  it("summarizes facts per period and category", () => {
    const f = (period: string, outcome: CareFact["outcome"], day: string): CareFact => ({
      factId: Math.random().toString(16).slice(2).padEnd(24, "0").slice(0, 24),
      householdId: "h", period, category: "medication_confirmation", outcome, occurredOn: `${period}-${day}`,
    });
    const rows = summarizeCareFacts([f("2026-10", "taken", "01"), f("2026-10", "skipped", "01"), f("2026-10", "taken", "02"), f("2026-09", "taken", "30")]);
    expect(rows).toEqual([
      { period: "2026-10", category: "medication_confirmation", total: 3, outcomes: { taken: 2, skipped: 1, completed: 0, open: 0, declined: 0 }, activeDays: 2 },
      { period: "2026-09", category: "medication_confirmation", total: 1, outcomes: { taken: 1, skipped: 0, completed: 0, open: 0, declined: 0 }, activeDays: 1 },
    ]);
    expect(previousPeriod("2026-01")).toBe("2025-12");
  });

  it("live adapter: runs the summary as a Snowflake query and maps array rows", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { statement } = JSON.parse(String(init.body)) as { statement: string };
      const payload = statement.startsWith("SELECT period")
        ? {
            resultSetMetaData: { rowType: ["PERIOD", "CATEGORY", "TOTAL", "TAKEN", "SKIPPED", "COMPLETED", "OPEN_COUNT", "DECLINED", "ACTIVE_DAYS"].map((name) => ({ name })) },
            data: [["2026-10", "medication_confirmation", "4", "3", "1", "0", "0", "0", "3"]],
          }
        : { resultSetMetaData: { rowType: [] }, data: [] };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const sf = new SnowflakeAnalytics({ account: "acme-kinline", token: "t0k", warehouse: "WH", database: "DB", schema: "PUBLIC" });
    const rows = await sf.summarizeCare({ householdId: "h1", authorizedHouseholds: ["h1"], periods: ["2026-10", "2026-09"] });
    expect(rows).toEqual([
      { period: "2026-10", category: "medication_confirmation", total: 4, outcomes: { taken: 3, skipped: 1, completed: 0, open: 0, declined: 0 }, activeDays: 3 },
    ]);

    const last = calls.at(-1)!;
    expect(last.url).toBe("https://acme-kinline.snowflakecomputing.com/api/v2/statements");
    const headers = last.init.headers as Record<string, string>;
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe("PROGRAMMATIC_ACCESS_TOKEN");
    const body = JSON.parse(String(last.init.body));
    expect(body).toMatchObject({ warehouse: "WH", database: "DB", schema: "PUBLIC" });
    expect(body.statement).toMatch(/GROUP BY period, category/);
    expect(body.bindings).toEqual({ "1": { type: "TEXT", value: "h1" }, "2": { type: "TEXT", value: "2026-10" }, "3": { type: "TEXT", value: "2026-09" } });

    // Unauthorized household: no query is even sent.
    const before = calls.length;
    expect(await sf.summarizeCare({ householdId: "h2", authorizedHouseholds: ["h1"], periods: ["2026-10"] })).toEqual([]);
    expect(calls.length).toBe(before);
  });
});
