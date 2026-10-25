/**
 * npm run demo:scam-call
 *
 * The scam-call demo end to end, voiced and heard by Cartesia (fictional data):
 *   1. Cartesia sonic-3 speaks each line of a fake-grandson call (the "caller").
 *   2. Cartesia ink-whisper streaming STT transcribes that audio, like a live call.
 *   3. Claude + the deterministic scam rules screen the rolling transcript.
 *   4. Once it reads as a scam, Guardian's workflow runs: policy blocks the
 *      transfer, verifies with the real Jake, records an incident, alerts Sarah.
 *   5. Cartesia speaks Guardian's private warning. Both audio files are saved.
 *
 * Without CARTESIA_API_KEY the script text stands in for STT (clearly labelled).
 * Twilio is disabled for this run so caregiver alerts stay in-app.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load .env.local into process.env BEFORE importing anything that reads env.
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env.local -> runs in sandbox */
}
for (const key of Object.keys(process.env)) if (key.startsWith("TWILIO_")) delete process.env[key];

const { cartesiaStatus, isClaudeLive } = await import("@/lib/env");
const { synthesizeSpeech, transcribePcm } = await import("@/integrations/cartesia");
const { screenCallTranscript } = await import("@/integrations/callScreening");
const { createInMemoryDataLayer } = await import("@/agents/base/memoryStore");
const { AgentService } = await import("@/agents/service");
const { MARGARET_USER, seedMargaretScenario } = await import("@/agents/guardian/scamScenario");
const { SCAM_CALL_SCRIPT } = await import("@/agents/guardian/scamCallScript");

function line(c = "─") {
  console.log(c.repeat(68));
}

const data = createInMemoryDataLayer();
await seedMargaretScenario(data, MARGARET_USER);
const service = new AgentService(data, MARGARET_USER);
const cartesiaLive = cartesiaStatus().mode === "live";
const callId = `demo-call-${Date.now()}`;
const countIncidents = async () =>
  (await data.memory.list({ namespace: "guardian", userId: MARGARET_USER, collection: "incidents", tag: "incident" })).length;
const incidentsBefore = await countIncidents();

line("═");
console.log("Sahaya: scam-call demo with Cartesia voice (fictional data)");
line("═");
console.log(`Cartesia: ${cartesiaLive ? "LIVE (sonic-3 TTS + ink-whisper STT)" : "sandbox (script text stands in for STT)"}`);
console.log(`Screening: ${isClaudeLive() ? "Claude + deterministic rules" : "deterministic rules only"}`);
console.log(`\nMargaret's phone rings. "Jake" is calling...\n`);

const transcript: string[] = [];
const callerAudio: Buffer[] = [];
let sttHeard = 0;
let result: Awaited<ReturnType<typeof screenCallTranscript>> | null = null;

for (const scripted of SCAM_CALL_SCRIPT) {
  let heard: string[] = [scripted];
  let source = "script";
  if (cartesiaLive) {
    const audio = await synthesizeSpeech(scripted, undefined, { persona: "scam-caller", format: "pcm16k" });
    if (!audio) throw new Error("Cartesia TTS returned no audio");
    const pcm = Buffer.from(audio.audio);
    callerAudio.push(pcm);
    const phrases = await transcribePcm(pcm);
    if (!phrases?.length) throw new Error("Cartesia STT returned no transcript");
    heard = phrases;
    source = "Cartesia STT";
    sttHeard++;
  }
  for (const p of heard) {
    transcript.push(p);
    console.log(`  Caller (${source}): ${p}`);
  }

  result = await screenCallTranscript({ callId, userId: MARGARET_USER, transcript: transcript.join("\n"), service });
  console.log(`    -> Guardian: ${result.verdict.toUpperCase()} (risk ${result.risk}, ${result.mode})`);
  if (result.escalated) break;
}

line();
if (!result) throw new Error("no screening result");
console.log("Guardian says privately to Margaret:\n");
console.log(`  ${result.advice}\n`);
if (result.reasons.length) {
  console.log("Red flags heard:");
  for (const r of result.reasons) console.log(`  • ${r}`);
}

const out = tmpdir();
if (cartesiaLive) {
  const callerPath = join(out, "sahaya-scam-call-caller.wav");
  writeFileSync(callerPath, wav16k(Buffer.concat(callerAudio)));
  const warning = await synthesizeSpeech(result.advice, undefined, { persona: "guardian" });
  if (warning) {
    const warningPath = join(out, "sahaya-guardian-warning.mp3");
    writeFileSync(warningPath, Buffer.from(warning.audio));
    console.log(`\nAudio saved:\n  caller:  ${callerPath}\n  warning: ${warningPath}`);
  }
}

const incidentsAfter = (await countIncidents()) - incidentsBefore;
console.log(`\nNew incident recorded from this call: ${incidentsAfter}`);

line("═");
const ok = result.verdict === "scam" && result.escalated && incidentsAfter === 1 && (!cartesiaLive || sttHeard > 0);
console.log(
  ok
    ? `✓ Acceptance met: ${cartesiaLive ? "Cartesia voiced and transcribed the call, " : ""}scam detected, one incident, Guardian warned.`
    : "✗ Acceptance NOT met.",
);
line("═");
if (!ok) process.exit(1);

/** Wrap raw 16 kHz mono s16le PCM in a WAV header so it plays anywhere. */
function wav16k(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
