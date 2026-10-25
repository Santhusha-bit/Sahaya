import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import type { BaseAgent } from "@/agents/base/BaseAgent";
import { activeObservations, allObservations } from "@/agents/wellness/wellnessStore";
import { runWellnessTurn } from "@/agents/wellness/wellnessWorkflow";
import {
  DEMO_HOUSEHOLD,
  getHouseholdAnalytics,
  updateHouseholdAnalytics,
} from "@/agents/wellness/householdAnalytics";
import { resetTimeSeriesProvider, setTimeSeriesProvider, type TimeSeriesProvider } from "@/integrations/tigerdata";
import { resetAnalyticsProvider } from "@/integrations/snowflake";
import { resetPersonalMemoryProvider } from "@/integrations/moss";
import { resetConversationMemoryProvider } from "@/integrations/backboard";
import { resetWellnessInferenceProvider } from "@/integrations/bitdeer";

function wellnessFor(userId = "margaret", consent = DEFAULT_CONSENT): Promise<BaseAgent> {
  const data = createInMemoryDataLayer();
  const agent = createAgent("wellness", { data, userId, consent });
  return agent.initialize().then(() => agent);
}

afterEach(() => {
  resetTimeSeriesProvider();
  resetAnalyticsProvider();
  resetPersonalMemoryProvider();
  resetConversationMemoryProvider();
  resetWellnessInferenceProvider();
});

describe("full wellness turn", () => {
  it("extracts, stores canonically, trends, and responds non-diagnostically", async () => {
    const w = await wellnessFor();
    const r = await runWellnessTurn({
      text: "I haven't been sleeping well lately. I only slept four hours last night.",
      memory: w.memory,
      userId: "margaret",
      consent: DEFAULT_CONSENT,
      audit: w.audit,
    });
    expect(r.extraction.accepted.some((o) => o.type === "sleep_duration" && o.value === 4)).toBe(true);
    const stored = await activeObservations(w.memory);
    expect(stored.length).toBeGreaterThan(0);
    // Non-diagnostic: never asserts a medical condition.
    expect(r.followUp.toLowerCase()).not.toMatch(/insomnia|depression|diagnos/);
  });

  it("does not corrupt canonical data when an integration fails", async () => {
    const w = await wellnessFor();
    await runWellnessTurn({ text: "I slept five hours.", memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const before = (await activeObservations(w.memory)).length;

    const broken: TimeSeriesProvider = {
      backend: "tigerdata",
      async status() { return { backend: "tigerdata" as const, mode: "unavailable" as const, detail: "down" }; },
      async upsert() { throw new Error("down"); },
      async remove() { throw new Error("down"); },
      async purgeUser() { throw new Error("down"); },
      async points() { throw new Error("down"); },
      async aggregate() { throw new Error("down"); },
    };
    setTimeSeriesProvider(broken);
    const r = await runWellnessTurn({ text: "I slept three hours.", memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const after = (await activeObservations(w.memory)).length;

    expect(after).toBe(before + 1); // canonical still written
    const tsSync = r.syncs.find((s) => s.integration === "tigerdata");
    expect(tsSync?.ok).toBe(false); // failure reported honestly, not as success
  });

  it("dedups identical observations so the trend is not inflated", async () => {
    const w = await wellnessFor();
    const msg = "I slept around five hours last night.";
    await runWellnessTurn({ text: msg, memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    await runWellnessTurn({ text: msg, memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const sleep = (await activeObservations(w.memory)).filter((o) => o.type === "sleep_duration");
    expect(sleep).toHaveLength(1);
  });
});

describe("memory correction and deletion", () => {
  it("correction returns the new value and never the stale one", async () => {
    const w = await wellnessFor();
    await w.executeTool("extractWellnessObservations", { text: "I slept five hours last night." });
    const sleep = (await activeObservations(w.memory)).find((o) => o.type === "sleep_duration")!;
    await w.executeTool("correctRememberedObservation", { recordId: sleep.recordId, value: 7, unit: "hours" });
    const after = (await activeObservations(w.memory)).find((o) => o.recordId === sleep.recordId)!;
    expect(after.value).toBe(7);
  });

  it("deleted observations do not appear in the active reader but remain for audit", async () => {
    const w = await wellnessFor();
    await w.executeTool("extractWellnessObservations", { text: "I slept five hours last night." });
    const sleep = (await activeObservations(w.memory)).find((o) => o.type === "sleep_duration")!;
    await w.executeTool("forgetRememberedObservation", { recordId: sleep.recordId });
    expect((await activeObservations(w.memory)).some((o) => o.recordId === sleep.recordId)).toBe(false);
    expect((await allObservations(w.memory)).some((o) => o.recordId === sleep.recordId && o.status === "deleted")).toBe(true);
  });
});

describe("household analytics authorization", () => {
  it("lets an authorized caregiver read aggregates but refuses outsiders", async () => {
    const w = await wellnessFor();
    await w.executeTool("extractWellnessObservations", { text: "I slept five hours and felt lonely." });
    await updateHouseholdAnalytics({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });

    const authorized = await getHouseholdAnalytics({
      requester: { role: "caregiver", householdId: DEMO_HOUSEHOLD },
      targetHouseholdId: DEMO_HOUSEHOLD,
    });
    expect(authorized.ok).toBe(true);
    expect(authorized.aggregates.length).toBeGreaterThan(0);

    const outsider = await getHouseholdAnalytics({
      requester: { role: "caregiver", householdId: "other" },
      targetHouseholdId: DEMO_HOUSEHOLD,
    });
    expect(outsider.ok).toBe(false);
    expect(outsider.aggregates).toHaveLength(0);
  });

  it("withdraws aggregates when analytics consent is revoked", async () => {
    const w = await wellnessFor();
    await w.executeTool("extractWellnessObservations", { text: "I slept five hours." });
    await updateHouseholdAnalytics({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    await updateHouseholdAnalytics({
      memory: w.memory,
      userId: "margaret",
      consent: { ...DEFAULT_CONSENT, wellnessHouseholdAnalytics: false },
    });
    const after = await getHouseholdAnalytics({
      requester: { role: "caregiver", householdId: DEMO_HOUSEHOLD },
      targetHouseholdId: DEMO_HOUSEHOLD,
    });
    expect(after.aggregates).toHaveLength(0);
  });

  it("aggregates contain only numeric values, never raw conversation text", async () => {
    const w = await wellnessFor();
    await w.executeTool("extractWellnessObservations", { text: "I slept five hours and my SSN is 123-45-6789." });
    await updateHouseholdAnalytics({ memory: w.memory, userId: "margaret", consent: DEFAULT_CONSENT });
    const res = await getHouseholdAnalytics({
      requester: { role: "caregiver", householdId: DEMO_HOUSEHOLD },
      targetHouseholdId: DEMO_HOUSEHOLD,
    });
    for (const a of res.aggregates) {
      expect(typeof a.value).toBe("number");
      expect(JSON.stringify(a)).not.toContain("123-45-6789");
    }
  });
});
