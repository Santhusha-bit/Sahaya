/**
 * npm run demo:wellness-full
 *
 * The Part 5 main scenario, end to end. Margaret says:
 *   "I haven't been sleeping well lately. I only slept four hours last night."
 * and over several days we see: Bitdeer extraction -> policy validation -> Convex
 * canonical store -> Moss continuity -> Backboard history -> Tiger Data trend ->
 * contextual non-diagnostic follow-up -> authorized household analytics for Sarah
 * -> a monthly report. Finally we confirm an integration failure degrades safely.
 */

import { allIntegrationStatuses } from "@/lib/env";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { setConsent } from "@/agents/consent";
import { runWellnessTurn } from "@/agents/wellness/wellnessWorkflow";
import { activeObservations } from "@/agents/wellness/wellnessStore";
import { DEMO_HOUSEHOLD, buildMonthlyReport, getHouseholdAnalytics, updateHouseholdAnalytics } from "@/agents/wellness/householdAnalytics";
import { setTimeSeriesProvider, type TimeSeriesProvider } from "@/integrations/tigerdata";

function line(c = "─") { console.log(c.repeat(72)); }

async function main() {
  const data = createInMemoryDataLayer();
  await setConsent(data, "margaret", DEFAULT_CONSENT);
  const wellness = createAgent("wellness", { data, userId: "margaret", consent: DEFAULT_CONSENT });
  await wellness.initialize();

  line("═");
  console.log("KINLINE — Full Wellness integration (Margaret's week)");
  console.log("Integrations:");
  for (const s of allIntegrationStatuses().filter((x) => ["claude", "bitdeer", "convex", "moss", "backboard", "tigerdata", "snowflake"].includes(x.key))) {
    console.log(`   - ${s.label}: ${s.mode}`);
  }
  line("═");

  // A week of messages, sleep getting worse, feeding the trend.
  const week = [
    "I slept about seven hours and had a nice chat with my neighbor.",
    "I slept around six hours last night.",
    "I only slept five hours and felt a bit tired.",
    "I haven't been sleeping well lately. I only slept four hours last night.",
  ];

  for (const text of week) {
    const r = await runWellnessTurn({ text, memory: wellness.memory, userId: "margaret", consent: DEFAULT_CONSENT, audit: wellness.audit });
    console.log(`\n▸ "${text}"`);
    for (const o of r.extraction.accepted) console.log(`   extracted: ${o.type} ${o.value ?? ""}${o.unit ?? ""} ${o.description ?? ""}`.trimEnd());
    if (r.recalled.length) console.log(`   context recalled (Backboard, verified): ${r.recalled.map((c) => c.topic).join(", ")}`);
    console.log(`   sleep trend: ${r.sleepTrend.direction} (avg ${r.sleepTrend.average}h over ${r.sleepTrend.count} nights)`);
    console.log(`   Wellness: ${r.followUp}`);
  }

  const active = await activeObservations(wellness.memory);
  console.log(`\nCanonical observations stored (Convex source of truth): ${active.length}`);

  // Authorized household analytics for Sarah + a monthly report.
  await updateHouseholdAnalytics({ memory: wellness.memory, userId: "margaret", consent: DEFAULT_CONSENT, audit: wellness.audit });
  const sarah = { role: "caregiver" as const, householdId: DEMO_HOUSEHOLD };
  const analytics = await getHouseholdAnalytics({ requester: sarah, targetHouseholdId: DEMO_HOUSEHOLD });
  const period = new Date(active[0]?.createdAt ?? 1_760_000_000_000).toISOString().slice(0, 7);
  const report = buildMonthlyReport(period, analytics.aggregates);
  console.log(`\nSarah's monthly household report (${report.period}) — "${report.headline}"`);
  for (const l of report.lines) console.log(`   • ${l}`);

  // Integration failure degrades safely: a throwing time-series provider must not
  // corrupt the canonical record or throw out of the turn.
  const before = (await activeObservations(wellness.memory)).length;
  const brokenTs: TimeSeriesProvider = {
    backend: "tigerdata",
    async append() { throw new Error("Tiger Data unreachable"); },
    async range() { throw new Error("Tiger Data unreachable"); },
    async trend() { throw new Error("Tiger Data unreachable"); },
  };
  setTimeSeriesProvider(brokenTs);
  const degraded = await runWellnessTurn({ text: "I barely slept, maybe three hours.", memory: wellness.memory, userId: "margaret", consent: DEFAULT_CONSENT, audit: wellness.audit });
  const after = (await activeObservations(wellness.memory)).length;
  const tsSync = degraded.syncs.find((s) => s.integration === "tigerdata");
  console.log(`\nWith Tiger Data down: turn still completed, canonical grew ${before} -> ${after}, sync honestly reported ok=${tsSync?.ok}.`);

  line("═");
  const ok = active.length >= 4 && analytics.aggregates.length > 0 && tsSync?.ok === false && after > before;
  console.log(ok ? "✓ Full scenario works; analytics authorized; failure degraded safely and honestly." : "✗ The full scenario did not meet its guarantees.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
