/**
 * npm run demo:bitdeer [-- "custom message"]
 *
 * Bitdeer AI Model Studio as a separate, verifiable inference path. For each
 * message this shows the whole chain through the REAL Wellness tool
 * (extractWellnessObservations), not a side script:
 *
 *   1. the privacy-filtered text actually sent to Bitdeer,
 *   2. the live model request (endpoint, model) and Bitdeer's response id,
 *      latency, token usage and raw JSON output,
 *   3. strict schema + evidence validation against the original message,
 *   4. the stored observation, carrying the Bitdeer request id as provenance.
 *
 * With BITDEER_API_KEY set this makes REAL requests; without it the labeled
 * sandbox extractor runs through the identical pipeline. The model is advisory:
 * nothing it proposes is stored until deterministic code accepts it.
 */

import { readFileSync } from "node:fs";

// Load .env.local before anything reads env, so the demo uses the live key.
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const l of raw.split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env.local -> sandbox */
}

type Obs = {
  type: string;
  value?: number;
  unit?: string;
  description?: string;
  evidence: string;
  provenance: { provider: string; model: string; mode: string; requestId?: string };
};

function line(c = "─") {
  console.log(c.repeat(72));
}

const SAMPLES = [
  "I slept around five hours last night and felt tired this morning.",
  "I haven't been sleeping well lately. I only slept four hours last night.",
  "I had a lovely visit from my neighbor and felt happy all afternoon.",
  // Vague: must NOT become an invented numeric rating.
  "My energy has been all over the place.",
];

async function main() {
  const { bitdeerStatus } = await import("@/lib/env");
  const { DEFAULT_CONSENT } = await import("@/agents/base/policy");
  const { createInMemoryDataLayer } = await import("@/agents/base/memoryStore");
  const { createAgent } = await import("@/agents/registry");
  const { setConsent } = await import("@/agents/consent");
  const { getWellnessInferenceProvider } = await import("@/integrations/bitdeer");
  const { activeObservations } = await import("@/agents/wellness/wellnessStore");

  const custom = process.argv.slice(2).join(" ").trim();
  const samples = custom ? [custom] : SAMPLES;

  const data = createInMemoryDataLayer();
  await setConsent(data, "margaret", DEFAULT_CONSENT);
  const wellness = createAgent("wellness", { data, userId: "margaret", consent: DEFAULT_CONSENT });
  await wellness.initialize();

  const status = bitdeerStatus();
  const provider = getWellnessInferenceProvider();
  line("═");
  console.log(`SAHAYA: Bitdeer AI Model Studio inference path (mode: ${status.mode})`);
  console.log(status.detail);
  console.log(`Provider: ${provider.name}  |  Model: ${provider.model}`);
  line("═");

  let ok = true;
  const fail = (msg: string) => {
    console.error(`   ✗ ${msg}`);
    ok = false;
  };

  for (const text of samples) {
    const { result } = await wellness.executeTool("extractWellnessObservations", { text });
    const d = (result.data ?? {}) as {
      sentText?: string;
      trace?: { requestId: string; endpoint: string; latencyMs: number; finishReason?: string; usage?: Record<string, number | undefined>; rawContent: string };
      inferenceError?: string;
      accepted?: Obs[];
      needsConfirmation?: Obs[];
      rejected?: { type?: string; reason: string; layer: string }[];
      savedIds?: string[];
      provenance?: { redactions: number };
    };

    console.log(`\n▸ Conversation: "${text}"`);
    console.log(`  1. sent to model (${d.provenance?.redactions ?? 0} redaction(s)): "${d.sentText}"`);
    if (d.inferenceError) {
      fail(`model call failed: ${d.inferenceError}`);
      continue;
    }
    const t = d.trace!;
    const u = t.usage ?? {};
    console.log(`  2. POST ${t.endpoint}`);
    console.log(`     response id: ${t.requestId}  |  ${t.latencyMs} ms  |  finish: ${t.finishReason}  |  tokens in/out: ${u.promptTokens ?? "-"}/${u.completionTokens ?? "-"}`);
    console.log(`     raw output: ${t.rawContent}`);
    console.log("  3. validation against the original message:");
    for (const o of d.accepted ?? []) {
      const val = o.value !== undefined ? ` = ${o.value} ${o.unit ?? ""}`.trimEnd() : "";
      console.log(`     ✓ accepted  ${o.type}${val}${o.description ? ` "${o.description}"` : ""}  [evidence: "${o.evidence}"]`);
    }
    for (const o of d.needsConfirmation ?? []) console.log(`     ? confirm   ${o.type} "${o.description ?? o.value}"`);
    for (const r of d.rejected ?? []) console.log(`     ✗ rejected  ${r.type ?? "?"} (${r.layer}): ${r.reason}`);
    if (!d.accepted?.length && !d.needsConfirmation?.length && !d.rejected?.length) console.log("     (no observations proposed)");

    // Provenance must point back at this exact inference call.
    for (const o of d.accepted ?? []) {
      if (o.provenance.requestId !== t.requestId) fail(`${o.type} provenance does not reference request ${t.requestId}`);
      if (o.value !== undefined && !o.evidence.toLowerCase().match(/\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve/)) {
        fail(`${o.type}=${o.value} cites evidence without the number: "${o.evidence}"`);
      }
    }
    console.log(`  4. stored: ${d.savedIds?.length ?? 0} new record(s)`);

    if (!custom && text === SAMPLES[0]) {
      const sleep = d.accepted?.find((o) => o.type === "sleep_duration");
      if (!sleep || sleep.value !== 5 || sleep.unit !== "hours") fail("expected a grounded sleep_duration = 5 hours");
    }
    if (!custom && text === SAMPLES[3] && d.accepted?.some((o) => o.value !== undefined)) {
      fail("a vague description was turned into a numeric value");
    }
  }

  const stored = await activeObservations(wellness.memory);
  line();
  console.log(`Canonical store: ${stored.length} observation(s), each with model provenance:`);
  for (const s of stored) {
    const val = s.value !== undefined ? ` ${s.value}${s.unit ?? ""}` : ` "${s.description}"`;
    console.log(`   ${s.recordId}  ${s.type}${val}  <- ${s.provenance.provider}/${s.provenance.model} (${s.provenance.mode}) request ${s.provenance.requestId ?? "n/a"}`);
    if (!s.provenance.requestId) fail(`${s.recordId} has no request id in provenance`);
  }

  line("═");
  console.log(ok ? "✓ Verified: live request -> validated, grounded observations -> stored with request provenance." : "✗ The inference path produced an unverifiable or ungrounded result.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
