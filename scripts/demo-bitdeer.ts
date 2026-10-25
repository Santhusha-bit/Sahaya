/**
 * npm run demo:bitdeer
 *
 * Shows the Bitdeer AI Model Studio structured-extraction task end to end. With
 * BITDEER_API_KEY set, it makes a REAL model request; otherwise it runs the
 * labeled sandbox equivalent (same interface, same strict validation). Either way,
 * candidate observations are schema-validated and evidence-checked in code before
 * anything is accepted — the model is strictly advisory.
 */

import { bitdeerStatus } from "@/lib/env";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { getWellnessInferenceProvider } from "@/integrations/bitdeer";
import { extractObservations } from "@/agents/wellness/extractObservations";

function line(c = "─") {
  console.log(c.repeat(70));
}

const SAMPLES = [
  "I slept around five hours last night and felt tired this morning.",
  "I haven't been sleeping well lately. I only slept four hours last night.",
  "I had a lovely visit from my neighbor and felt happy all afternoon.",
  // A deliberately vague one: must NOT become an invented numeric rating.
  "My energy has been all over the place.",
];

async function main() {
  const status = bitdeerStatus();
  const provider = getWellnessInferenceProvider();

  line("═");
  console.log(`Sahaya — Bitdeer structured wellness extraction (mode: ${status.mode})`);
  console.log(status.detail);
  console.log(`Provider: ${provider.name}  |  Model: ${provider.model}`);
  line("═");

  let ok = true;
  for (const text of SAMPLES) {
    const result = await extractObservations({ text, consent: DEFAULT_CONSENT });
    console.log(`\n▸ "${text}"`);
    console.log(`  provenance: ${result.provenance.provider}/${result.provenance.model} (${result.provenance.mode})`);
    for (const o of result.accepted) {
      const val = o.value !== undefined ? ` = ${o.value} ${o.unit ?? ""}`.trimEnd() : "";
      console.log(`   ✓ ${o.type}${val}${o.description ? ` — "${o.description}"` : ""}  [evidence: "${o.evidence}"]`);
    }
    for (const o of result.needsConfirmation) {
      console.log(`   ? ${o.type} — "${o.description ?? o.value}" (needs confirmation)`);
    }
    for (const r of result.rejected) {
      console.log(`   ✗ rejected ${r.candidate.type ?? "?"} — ${r.reason}`);
    }
    if (!result.accepted.length && !result.needsConfirmation.length && !result.rejected.length) {
      console.log("   (no observations)");
    }
  }

  // Assertion: the vague energy sample must never yield an accepted numeric value.
  const vague = await extractObservations({ text: "My energy has been all over the place.", consent: DEFAULT_CONSENT });
  const inventedNumber = vague.accepted.some((o) => o.value !== undefined);
  if (inventedNumber) {
    console.error("\n✗ A vague description was turned into a numeric value — this must never happen.");
    ok = false;
  }

  // Assertion: the canonical sample yields a grounded sleep_duration = 5 hours.
  const canonical = await extractObservations({
    text: "I slept around five hours last night and felt tired this morning.",
    consent: DEFAULT_CONSENT,
  });
  const sleep = canonical.accepted.find((o) => o.type === "sleep_duration");
  if (!sleep || sleep.value !== 5 || sleep.unit !== "hours") {
    console.error("\n✗ Expected a grounded sleep_duration = 5 hours from the canonical sample.");
    ok = false;
  }

  line("═");
  console.log(ok ? "✓ Extraction is grounded: real values kept, invented values rejected." : "✗ Extraction produced an ungrounded result.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
