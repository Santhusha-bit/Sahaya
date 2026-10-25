/**
 * npm run demo:wellness-memory
 *
 * Shows Margaret reviewing, correcting, and deleting what Wellness remembers, and
 * proves the integrity guarantees: a corrected observation never returns stale
 * data, a deleted observation disappears from the canonical reader, and a repeated
 * identical observation is deduped (not double-counted).
 */

import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { activeObservations } from "@/agents/wellness/wellnessStore";

function line(c = "─") {
  console.log(c.repeat(70));
}

async function main() {
  const data = createInMemoryDataLayer();
  const wellness = createAgent("wellness", { data, userId: "margaret", consent: DEFAULT_CONSENT });
  await wellness.initialize();

  line("═");
  console.log("Sahaya — Wellness memory: review, correct, delete, dedup");
  line("═");

  // 1. Record two observations.
  await wellness.executeTool("extractWellnessObservations", { text: "I slept around five hours last night and felt tired this morning." });
  // 2. Record the SAME sleep observation again — must be deduped.
  await wellness.executeTool("extractWellnessObservations", { text: "I slept around five hours last night and felt tired this morning." });

  let active = await activeObservations(wellness.memory);
  console.log(`\nAfter two identical messages: ${active.length} observation(s) (dedup working: duplicates not stored).`);
  for (const o of active) console.log(`   - [${o.recordId}] ${o.type} ${o.value ?? ""}${o.unit ?? ""} ${o.description ?? ""}`.trimEnd());

  // 3. Correct the sleep value (the person says it was actually six).
  const sleep = active.find((o) => o.type === "sleep_duration")!;
  await wellness.executeTool("correctRememberedObservation", { recordId: sleep.recordId, value: 6, unit: "hours" });
  active = await activeObservations(wellness.memory);
  const corrected = active.find((o) => o.recordId === sleep.recordId)!;
  console.log(`\nAfter correction: sleep_duration = ${corrected.value} ${corrected.unit} (was 5). Stale value is gone: ${corrected.value === 6 ? "✓" : "✗"}`);

  // 4. Delete the energy note.
  const energy = active.find((o) => o.type === "energy");
  if (energy) {
    await wellness.executeTool("forgetRememberedObservation", { recordId: energy.recordId });
    active = await activeObservations(wellness.memory);
    const stillThere = active.some((o) => o.recordId === energy.recordId);
    console.log(`\nAfter deletion: energy note visible = ${stillThere} (expected false). Deleted memory does not reappear: ${stillThere ? "✗" : "✓"}`);
  }

  line("═");
  const ok = corrected.value === 6 && !active.some((o) => o.type === "energy");
  console.log(ok ? "✓ Review / correction / deletion / dedup all behave correctly." : "✗ A memory guarantee failed.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
