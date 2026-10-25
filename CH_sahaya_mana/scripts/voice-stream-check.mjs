#!/usr/bin/env node
/**
 * Real-time voice check through the running app (no API key needed here: it uses the app's token route).
 *   1. POST /api/voice/token → short-lived Cartesia access token (never printed)
 *   2. Stream a 16 kHz PCM version of an audio file to Cartesia STT over WebSocket, in real time
 *   3. Stream a short TTS reply in the configured voice and count the audio that arrives
 * Usage: node scripts/voice-stream-check.mjs [audio-file]   (macOS: converts with afconvert)
 * Env:   SAHAYA_URL (default http://localhost:3000)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const base = process.env.SAHAYA_URL ?? process.env.KINLINE_URL ?? "http://localhost:3000"; // KINLINE_URL: deprecated name
const input = process.argv[2] ?? "/tmp/sahaya-voice-test.mp3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const res = await fetch(`${base}/api/voice/token`, { method: "POST" });
  const body = await res.json();
  console.log(`token route: HTTP ${res.status}${res.ok ? `, expires in ${body.expiresInSecs}s, voice ${body.config.voiceId}` : `, ${body.code}: ${body.error}`}`);
  if (!res.ok) process.exit(1);
  return body;
}

function pcm16k(file) {
  const out = "/tmp/sahaya-voice-test-16k.wav";
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", file, out]);
  const wav = readFileSync(out);
  let off = 12;
  while (off < wav.length - 8) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in converted WAV");
}

async function stt({ token: tok, config }, pcm) {
  const q = new URLSearchParams({
    model: config.sttModel,
    encoding: "pcm_s16le",
    sample_rate: String(config.inputSampleRate),
    cartesia_version: config.cartesiaVersion,
    language: "en",
    min_volume: String(config.minVolume),
    max_silence_duration_secs: String(config.maxSilenceSecs),
    access_token: tok,
  });
  const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${q}`);
  ws.binaryType = "arraybuffer";
  let partials = 0;
  let finalText = "";
  let audioEndAt = 0;
  let firstFinalAfterEndMs = null;
  let error = null;
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("STT socket failed to open"));
  });
  let flushed;
  const flushDone = new Promise((r) => (flushed = r));
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "transcript") {
      if (msg.is_final) {
        finalText += msg.text;
        if (audioEndAt && firstFinalAfterEndMs === null) firstFinalAfterEndMs = Date.now() - audioEndAt;
      } else partials++;
    } else if (msg.type === "flush_done" || msg.type === "done") flushed();
    else if (msg.type === "error") {
      error = `${msg.status_code} ${msg.title}`;
      flushed();
    }
  };
  await opened;
  console.log("STT socket: open (authenticated with the access token)");
  const chunk = 3200; // 100 ms of 16 kHz PCM16
  for (let i = 0; i < pcm.length; i += chunk) {
    ws.send(pcm.subarray(i, i + chunk));
    await sleep(100);
  }
  audioEndAt = Date.now();
  const silence = Buffer.alloc(chunk);
  for (let i = 0; i < 12; i++) {
    ws.send(silence);
    await sleep(100);
  }
  ws.send("finalize");
  await Promise.race([flushDone, sleep(8000)]);
  ws.send("close");
  await sleep(300);
  ws.close();
  console.log(`STT result: ${error ? `error ${error}` : `"${finalText.trim()}"`} (partials: ${partials}, first final ${firstFinalAfterEndMs ?? "n/a"} ms after the audio ended)`);
  return { ok: !error && finalText.trim().length > 0, text: finalText.trim() };
}

async function tts({ token: tok, config }) {
  const q = new URLSearchParams({ cartesia_version: config.cartesiaVersion, access_token: tok });
  const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?${q}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("TTS socket failed to open"));
  });
  const contextId = crypto.randomUUID();
  const sentAt = Date.now();
  let bytes = 0;
  let chunks = 0;
  let firstAt = null;
  let error = null;
  const done = new Promise((resolve) => {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "chunk" && msg.data) {
        firstAt ??= Date.now();
        chunks++;
        bytes += Buffer.from(msg.data, "base64").length;
      } else if (msg.type === "done") resolve();
      else if (msg.type === "error") {
        error = `${msg.status_code} ${msg.title}: ${msg.message}`;
        resolve();
      }
    };
  });
  ws.send(
    JSON.stringify({
      model_id: config.ttsModel,
      transcript: "Hello Margaret. It's time for your morning medication. Have you taken it?",
      voice: config.voiceId,
      language: "en",
      context_id: contextId,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: config.outputSampleRate },
      generation_config: { speed: config.speed, volume: 1 },
      continue: false,
    }),
  );
  await Promise.race([done, sleep(15000)]);
  ws.close();
  const seconds = bytes / 2 / config.outputSampleRate;
  console.log(
    `TTS result: ${error ? `error ${error}` : `${chunks} chunks, ${bytes} bytes ≈ ${seconds.toFixed(1)} s of audio, first audio after ${firstAt ? firstAt - sentAt : "n/a"} ms`} (voice ${config.voiceId})`,
  );
  return { ok: !error && bytes > 0 };
}

const t1 = await token();
const pcm = pcm16k(input);
console.log(`input: ${input} → ${(pcm.length / 32000).toFixed(1)} s of 16 kHz PCM`);
const a = await stt(t1, pcm);
const b = await tts(t1);
console.log(a.ok && b.ok ? "RESULT: streaming STT and TTS both worked" : "RESULT: streaming check FAILED");
process.exit(a.ok && b.ok ? 0 : 2);
