/**
 * npm run demo:household
 *
 * Monthly family care summary, end to end:
 *   1. Care records medication confirmations; Care asks Guardian for help twice.
 *   2. The analytics export sends ONLY consented, de-identified facts to Snowflake.
 *   3. Snowflake computes the monthly summary (one GROUP BY query).
 *   4. Kinline retrieves the aggregates and builds the caregiver's report.
 *   5. Another household is refused; revoking consent withdraws that category.
 * Live with SNOWFLAKE_ACCOUNT + SNOWFLAKE_TOKEN (+ warehouse/database/schema),
 * else a labeled sandbox with the same interface and the same math.
 */

import { snowflakeStatus } from "@/lib/env";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { DEMO_HOUSEHOLD, updateHouseholdAnalytics } from "@/agents/wellness/householdAnalytics";
import { requestCareAssistance } from "@/integrations/fetchai";
import { resetAnalyticsProvider } from "@/integrations/snowflake";
import { exportHouseholdCareFacts, periodOf, previousPeriod } from "@/analytics/householdCareExport";
import { getFamilyCareReport, type FamilyCareReport } from "@/analytics/familyCareReport";

const USER = "margaret";

function line(c = "─") { console.log(c.repeat(70)); }

function print(r: FamilyCareReport) {
  console.log(`\n  ${r.monthLabel} · source: ${r.source}`);
  console.log(`  ${r.headline}`);
  for (const l of r.lines) console.log(`   • ${l}`);
  if (r.notShared.length) console.log(`   (not shared: ${r.notShared.join(", ")})`);
}

async function main() {
  resetAnalyticsProvider();
  const status = snowflakeStatus();
  const data = createInMemoryDataLayer();
  const period = periodOf(Date.now());
  const prev = previousPeriod(period);

  line("═");
  console.log(`KINLINE: monthly family care summary (Snowflake mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  // 1. Canonical activity, through the real agents.
  const care = createAgent("care", { data, userId: USER, consent: DEFAULT_CONSENT });
  await care.initialize();
  const doses = [true, true, false, true, true, true, false, true, true, true];
  for (const taken of doses) await care.executeTool("recordMedicationConfirmation", { medicationName: "Lisinopril", taken });
  // Last month's history, so the report can show a trend.
  const lastMonth = new Date(`${prev}-12T09:00:00Z`).getTime();
  for (const [i, taken] of [true, false, true, false, true, true].entries()) {
    await data.memory.put({
      id: `mem_hist_${i}`, namespace: "care", collection: "confirmations", userId: USER,
      data: { medicationName: "Lisinopril", taken }, createdAt: lastMonth, updatedAt: lastMonth,
    });
  }
  const pickup = await requestCareAssistance({ data, userId: USER, need: "collect Lisinopril refill from the pharmacy" });
  await requestCareAssistance({ data, userId: USER, need: "help carrying groceries upstairs" });
  await data.tasks.patch(pickup.taskId, { status: "completed", result: "Neighbor collected the refill" });

  const wellness = createAgent("wellness", { data, userId: USER, consent: DEFAULT_CONSENT });
  await wellness.initialize();
  await wellness.executeTool("extractWellnessObservations", { text: "I slept about seven hours and felt rested." });
  await updateHouseholdAnalytics({ memory: wellness.memory, userId: USER, consent: DEFAULT_CONSENT });
  console.log(`\n1. Recorded ${doses.length} dose confirmations, 2 help requests (1 completed), 1 check-in.`);

  // 2-3. Export consented facts; Snowflake aggregates.
  const exp = await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [period, prev] });
  console.log(`2. Export (${exp.mode}): ${exp.detail}`);
  const again = await exportHouseholdCareFacts({ data, userId: USER, consent: DEFAULT_CONSENT, periods: [period, prev] });
  console.log(`   Re-export (idempotent): ${again.detail}`);

  // 4. Caregiver retrieves the report.
  const sarah = { role: "caregiver" as const, householdId: DEMO_HOUSEHOLD };
  const res = await getFamilyCareReport({ requester: sarah, targetHouseholdId: DEMO_HOUSEHOLD, period, consent: DEFAULT_CONSENT });
  if (!res.ok) throw new Error(res.reason);
  console.log("3. Sarah (authorized caregiver) sees:");
  print(res.report);

  // 5a. Another household is refused.
  const outsider = await getFamilyCareReport({
    requester: { role: "caregiver", householdId: "other-household" }, targetHouseholdId: DEMO_HOUSEHOLD, period, consent: DEFAULT_CONSENT,
  });
  console.log(`\n4. Caregiver from another household: ${outsider.ok ? "SAW THE REPORT" : `refused (${outsider.reason})`}`);

  // 5b. Margaret stops sharing medication totals.
  const revoked = { ...DEFAULT_CONSENT, householdAnalyticsMedication: false };
  const withdrawn = await exportHouseholdCareFacts({ data, userId: USER, consent: revoked, periods: [period, prev] });
  console.log(`5. Medication sharing turned off: ${withdrawn.detail}`);
  const after = await getFamilyCareReport({ requester: sarah, targetHouseholdId: DEMO_HOUSEHOLD, period, consent: revoked });
  if (!after.ok) throw new Error(after.reason);
  print(after.report);

  line("═");
  const ok =
    res.report.medication?.rate === 0.8 &&
    res.report.assistance?.completed === 1 &&
    !outsider.ok &&
    after.report.medication === null &&
    withdrawn.categories.some((c) => c.category === "medication_confirmation" && c.withdrawn > 0);
  console.log(ok ? "✓ Consented export, Snowflake summary, household-scoped access, and revocation all hold." : "✗ A household analytics guarantee failed.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
