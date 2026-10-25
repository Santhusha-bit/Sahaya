/**
 * npm run demo:tigerdata
 *
 * Tiger Data longitudinal wellness trends, end to end:
 *   1. A few weeks of (fictional, labeled) sleep reports exist in Convex, the canonical store.
 *   2. The sync job mirrors the approved numeric observations into Tiger Data.
 *   3. Sahaya queries weekly aggregates and compares this week with Margaret's history,
 *      with evidence and uncertainty.
 *   4. Margaret says something in conversation; Wellness extracts a timestamped
 *      observation, saves it to Convex, the sync job mirrors it, and the trend updates.
 *   5. Re-sync is idempotent; a correction and a deletion propagate to the mirror;
 *      the family view hides source sentences; revoking consent purges the mirror.
 *
 * Live against a real Tiger Data service with TIGERDATA_SERVICE_URL=postgres://...,
 * otherwise a labeled in-process sandbox computing identical aggregates.
 */

import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { seedSleepHistory } from "@/agents/wellness/demoHistory";
import { getLongitudinalTrend, type LongitudinalTrend } from "@/agents/wellness/longitudinalTrends";
import { syncWellnessTimeSeries } from "@/agents/wellness/timeSeriesSync";
import { runWellnessTurn } from "@/agents/wellness/wellnessWorkflow";
import { activeObservations, correctObservation, deleteObservation } from "@/agents/wellness/wellnessStore";
import { getTimeSeriesProvider, resetTimeSeriesProvider } from "@/integrations/tigerdata";

function line(c = "─") { console.log(c.repeat(74)); }

function printTrend(t: LongitudinalTrend) {
  for (const b of t.buckets) {
    const isCurrent = t.current?.bucketStart === b.bucketStart;
    const margin = b.stddev !== null && b.count > 1 ? `±${(1.96 * b.stddev / Math.sqrt(b.count)).toFixed(2)}` : "   n/a";
    const bar = "█".repeat(Math.round(b.average * 3));
    console.log(`   ${b.label.padEnd(16)} ${b.average.toFixed(2).padStart(5)}h ${margin.padStart(6)}  n=${String(b.count).padEnd(2)} ${bar}${b.insufficient ? " (few reports)" : ""}${isCurrent ? "  <- this week" : ""}`);
  }
  console.log(`   usual (baseline): ${t.baseline.average ?? "n/a"}h over ${t.baseline.periods} earlier week(s), ${t.baseline.count} reports`);
  console.log(`   comparison: ${t.comparison.direction}${t.comparison.delta !== null ? ` (${t.comparison.delta > 0 ? "+" : ""}${t.comparison.delta}h)` : ""} · confidence ${t.uncertainty.confidence}${t.uncertainty.margin !== null ? ` · ±${t.uncertainty.margin}h` : ""}`);
  for (const r of t.uncertainty.reasons) console.log(`     - ${r}`);
  console.log(`   "${t.narrative}"`);
}

async function main() {
  resetTimeSeriesProvider();
  const ts = getTimeSeriesProvider();
  const userId = "margaret";
  const data = createInMemoryDataLayer();
  const wellness = createAgent("wellness", { data, userId, consent: DEFAULT_CONSENT });
  await wellness.initialize();
  const memory = wellness.memory;
  const consent = { ...DEFAULT_CONSENT };
  const checks: [string, boolean][] = [];

  const status = await ts.status();
  line("═");
  console.log(`SAHAYA: Tiger Data longitudinal wellness trends (backend: ${ts.backend}, mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  // 1. Canonical history in Convex.
  const seeded = await seedSleepHistory({ memory });
  const canonical = (await activeObservations(memory)).filter((o) => o.type === "sleep_duration");
  console.log(`\n1. Convex (canonical): ${canonical.length} sleep observations (${seeded.saved} fictional demo reports, labeled provider=demo-seed).`);

  // 2. Sync job.
  const first = await syncWellnessTimeSeries({ memory, userId, consent, audit: wellness.audit });
  console.log(`2. Sync job -> Tiger Data: ${first.inserted} inserted, ${first.updated} updated, ${first.removed} removed (ok=${first.ok}).`);
  checks.push(["initial sync mirrored every approved observation", first.ok && first.inserted === canonical.length]);

  // 3. Weekly aggregates + comparison.
  const before = await getLongitudinalTrend({ memory, userId, metric: "sleep" });
  console.log("\n3. Weekly sleep trend BEFORE the new conversation:");
  printTrend(before);

  // 4. A new conversational observation.
  line();
  const said = "I haven't been sleeping well. I only slept about four hours last night.";
  console.log(`4. Margaret: "${said}"`);
  const turn = await runWellnessTurn({ text: said, memory, userId, consent, audit: wellness.audit });
  for (const o of turn.extraction.accepted) {
    console.log(`   extracted: ${o.type} ${o.value ?? ""}${o.unit ? ` ${o.unit}` : ""} ${o.description ?? ""} at ${new Date(o.provenance.extractedAt).toISOString()}`.trimEnd());
    console.log(`     evidence: "${o.evidence}"`);
  }
  console.log(`   Convex saved: ${turn.savedCount} · ${turn.syncs.find((s) => s.integration === "tigerdata")?.detail}`);
  console.log(`   Wellness: "${turn.followUp}"`);

  const after = await getLongitudinalTrend({ memory, userId, metric: "sleep" });
  console.log("\n   Weekly sleep trend AFTER:");
  printTrend(after);
  const cb = before.current, ca = after.current!;
  console.log(`\n   This week: ${cb ? `${cb.average}h (n=${cb.count})` : "no reports"} -> ${ca.average}h (n=${ca.count}); confidence ${before.uncertainty.confidence} -> ${after.uncertainty.confidence}.`);
  console.log("   Newest evidence:", after.evidence[0] ? `${after.evidence[0].value}h, "${after.evidence[0].quote}"` : "none");
  checks.push(["the new observation reached the current week", ca.count === (cb?.bucketStart === ca.bucketStart ? cb.count : 0) + 1 && after.evidence.some((e) => e.value === 4)]);
  checks.push(["this week is compared below the usual level", after.comparison.direction === "lower"]);

  // 5a. Idempotent re-sync.
  line();
  const again = await syncWellnessTimeSeries({ memory, userId, consent });
  console.log(`5. Re-sync: ${again.inserted} inserted, ${again.unchanged} unchanged. Idempotent: ${again.inserted === 0 && again.updated === 0 ? "yes" : "NO"}`);
  checks.push(["re-sync is idempotent", again.inserted === 0 && again.updated === 0]);

  // 5b. Correction propagates.
  const four = (await activeObservations(memory)).find((o) => o.type === "sleep_duration" && o.value === 4)!;
  await correctObservation(memory, four.recordId, { value: 4.5, unit: "hours" });
  const corr = await syncWellnessTimeSeries({ memory, userId, consent });
  const afterCorr = await getLongitudinalTrend({ memory, userId, metric: "sleep" });
  console.log(`   Correction 4h -> 4.5h in Convex: sync updated ${corr.updated}; this week now ${afterCorr.current?.average}h.`);
  checks.push(["correction propagated", corr.updated === 1 && afterCorr.evidence.some((e) => e.value === 4.5 && e.corrected)]);

  // 5c. Family view: no source sentences without raw-sharing consent.
  const family = await getLongitudinalTrend({ memory, userId, metric: "sleep", audience: "family", consent });
  console.log(`   Family view: ${family.evidence.length} evidence item(s), quotes shown: ${family.evidence.some((e) => e.quote) ? "YES" : "no"} (caregiverWellnessRaw=${consent.caregiverWellnessRaw}).`);
  checks.push(["family view hides source sentences", family.evidence.length > 0 && !family.evidence.some((e) => e.quote)]);

  // 5d. Deletion propagates.
  await deleteObservation(memory, four.recordId);
  const del = await syncWellnessTimeSeries({ memory, userId, consent });
  const mirrored = await ts.points({ userId, metric: "sleep" });
  console.log(`   Forget that report: sync removed ${del.removed}; mirror still has it: ${mirrored.some((p) => p.observationId === four.id) ? "YES" : "no"}.`);
  checks.push(["deletion propagated", del.removed === 1 && !mirrored.some((p) => p.observationId === four.id)]);

  // 5e. Consent revocation purges the mirror.
  const revoked = await syncWellnessTimeSeries({ memory, userId, consent: { ...consent, wellnessTimeSeriesSync: false } });
  const left = await ts.points({ userId });
  const stillCanonical = (await activeObservations(memory)).length;
  console.log(`   Consent off: purged ${revoked.removed} point(s); mirror now ${left.length}; Convex still holds ${stillCanonical} observation(s).`);
  checks.push(["consent revocation purged the mirror", revoked.status === "purged_no_consent" && left.length === 0 && stillCanonical > 0]);

  line("═");
  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
  line("═");
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
