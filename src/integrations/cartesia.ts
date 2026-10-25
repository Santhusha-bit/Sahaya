import { cartesiaStatus } from "@/lib/env";

/**
 * Cartesia voice: sonic-3 text-to-speech and ink-whisper speech-to-text.
 *
 * - TTS returns audio bytes when a key is configured, otherwise null so the
 *   client falls back to the browser's SpeechSynthesis.
 * - STT runs over Cartesia's streaming WebSocket. Browsers never see the API
 *   key: the server mints a short-lived, STT-only access token for them.
 *
 * Honestly reported via cartesiaStatus().
 */

export const CARTESIA_VERSION = "2026-08-14";
export const CARTESIA_TTS_MODEL = "sonic-3";
export const CARTESIA_STT_MODEL = "ink-whisper";
export const CARTESIA_STT_URL = "wss://api.cartesia.ai/stt/websocket";
/** Sample rate the STT stream is sent at (browser and server both resample to it). */
export const CARTESIA_STT_SAMPLE_RATE = 16000;

const DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";
/** "Hugo": expressive young adult male, used to play the fake grandson in the demo call. */
const DEFAULT_CALLER_VOICE_ID = "1463a4e1-56a1-4b41-b257-728d56e93605";

/**
 * Named voices. "guardian" is Sahaya's calm private voice; "scam-caller" plays the
 * fictional impersonator in the simulated scam call (demo only).
 */
export type VoicePersona = "guardian" | "scam-caller";

interface PersonaConfig {
  voiceId: string;
  emotion?: string;
  speed?: number;
}

function personaConfig(persona: VoicePersona | undefined): PersonaConfig {
  if (persona === "scam-caller") {
    return { voiceId: process.env.CARTESIA_CALLER_VOICE_ID || DEFAULT_CALLER_VOICE_ID, emotion: "scared", speed: 1.05 };
  }
  return { voiceId: process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE_ID, emotion: persona === "guardian" ? "calm" : undefined };
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`,
    "Cartesia-Version": CARTESIA_VERSION,
  };
}

export interface SpeechOptions {
  persona?: VoicePersona;
  /** "mp3" for playback in an <audio> element, "pcm16k" for raw 16 kHz s16le (STT input). */
  format?: "mp3" | "pcm16k";
}

export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
  opts: SpeechOptions = {},
): Promise<{ audio: ArrayBuffer; contentType: string } | null> {
  if (cartesiaStatus().mode !== "live") return null;
  const persona = personaConfig(opts.persona);
  const voice = voiceId || persona.voiceId;
  const pcm = opts.format === "pcm16k";

  try {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model_id: CARTESIA_TTS_MODEL,
        transcript: text.slice(0, 2000),
        voice: { mode: "id", id: voice },
        output_format: pcm
          ? { container: "raw", encoding: "pcm_s16le", sample_rate: CARTESIA_STT_SAMPLE_RATE }
          : { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        language: "en",
        ...(persona.emotion || persona.speed
          ? { generation_config: { ...(persona.emotion ? { emotion: persona.emotion } : {}), ...(persona.speed ? { speed: persona.speed } : {}) } }
          : {}),
      }),
    });
    if (!res.ok) {
      console.warn("Cartesia TTS failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    return { audio: await res.arrayBuffer(), contentType: pcm ? "audio/pcm" : "audio/mpeg" };
  } catch (err) {
    console.warn("Cartesia TTS error:", err);
    return null;
  }
}

export interface SttSession {
  token: string;
  expiresIn: number;
  /** Fully-formed WebSocket URL (model, encoding, sample rate, version, token). */
  url: string;
  sampleRate: number;
}

/**
 * Mint a short-lived, STT-only Cartesia access token so a browser can stream call
 * audio straight to Cartesia without ever holding the API key. Null in sandbox.
 */
export async function createSttSession(expiresIn = 900): Promise<SttSession | null> {
  if (cartesiaStatus().mode !== "live") return null;
  try {
    const res = await fetch("https://api.cartesia.ai/access-token", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ grants: { stt: true }, expires_in: Math.min(Math.max(expiresIn, 60), 3600) }),
    });
    if (!res.ok) {
      console.warn("Cartesia access token failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const { token } = (await res.json()) as { token?: string };
    if (!token) return null;
    return { token, expiresIn, url: sttUrl(token), sampleRate: CARTESIA_STT_SAMPLE_RATE };
  } catch (err) {
    console.warn("Cartesia access token error:", err);
    return null;
  }
}

export function sttUrl(token: string, sampleRate = CARTESIA_STT_SAMPLE_RATE): string {
  const q = new URLSearchParams({
    model: CARTESIA_STT_MODEL,
    encoding: "pcm_s16le",
    sample_rate: String(sampleRate),
    cartesia_version: CARTESIA_VERSION,
    language: "en",
    access_token: token,
  });
  return `${CARTESIA_STT_URL}?${q}`;
}

/**
 * Transcribe raw 16 kHz s16le audio with Cartesia streaming STT (server side).
 * Streams ~100 ms chunks like a live call and resolves with each finalized phrase.
 */
export async function transcribePcm(pcm: Uint8Array, opts: { realtime?: boolean } = {}): Promise<string[] | null> {
  const session = await createSttSession(300);
  if (!session) return null;
  const chunk = (CARTESIA_STT_SAMPLE_RATE / 10) * 2;
  return new Promise((resolve, reject) => {
    const phrases: string[] = [];
    const ws = new WebSocket(session.url);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Cartesia STT timed out"));
    }, 60_000);
    ws.onopen = async () => {
      for (let i = 0; i < pcm.length; i += chunk) {
        ws.send(pcm.subarray(i, i + chunk));
        await new Promise((r) => setTimeout(r, opts.realtime ? 100 : 10));
      }
      ws.send("finalize");
      ws.send("close");
    };
    ws.onmessage = (e) => {
      let msg: { type?: string; is_final?: boolean; text?: string; message?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "transcript" && msg.is_final && msg.text?.trim()) phrases.push(msg.text.trim());
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(`Cartesia STT error: ${msg.message ?? "unknown"}`));
      }
      if (msg.type === "done") {
        clearTimeout(timer);
        ws.close();
        resolve(phrases);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Cartesia STT connection failed"));
    };
  });
}

/**
 * Voice-synthesis provider with the honest live/sandbox adapter pattern used across
 * src/integrations. The Wellness agent speaks its warm replies aloud, so it needs a
 * provider it can invoke directly (not only the client-side TTS helper above).
 *
 * - Live (CARTESIA_API_KEY set): produces real Cartesia MP3 audio.
 * - Sandbox (no key): a deterministic plan the client fulfils with the browser's
 *   SpeechSynthesis. Same interface, never pretends Cartesia ran.
 *
 * The provider never throws for a synthesis failure: it reports an honest result so
 * a voice hiccup can never break the spoken check-in or the canonical record.
 */
export interface VoiceSynthesisResult {
  /** Did we obtain real audio bytes? */
  ok: boolean;
  /** "live" only when real Cartesia audio was produced; otherwise "sandbox". */
  mode: "live" | "sandbox";
  /** The (possibly truncated) text that was spoken. */
  spoken: string;
  /** Base64-encoded audio when live; undefined in sandbox. */
  audioBase64?: string;
  contentType?: string;
  /** How the client should render speech. */
  playback: "cartesia-audio" | "browser-speech-synthesis";
  detail: string;
}

export interface VoiceProvider {
  readonly backend: "cartesia" | "sandbox";
  speak(text: string, voiceId?: string): Promise<VoiceSynthesisResult>;
}

/** Sandbox voice provider: hands the text back for browser SpeechSynthesis. */
export class SandboxVoiceProvider implements VoiceProvider {
  readonly backend = "sandbox" as const;
  async speak(text: string): Promise<VoiceSynthesisResult> {
    const spoken = text.slice(0, 2000);
    return {
      ok: false,
      mode: "sandbox",
      spoken,
      playback: "browser-speech-synthesis",
      detail: "Sandbox: no Cartesia key; the client speaks this with the browser's SpeechSynthesis.",
    };
  }
}

/** Live Cartesia voice provider (same interface). Used only when a key is configured. */
export class CartesiaVoiceProvider implements VoiceProvider {
  readonly backend = "cartesia" as const;
  async speak(text: string, voiceId?: string): Promise<VoiceSynthesisResult> {
    const spoken = text.slice(0, 2000);
    const out = await synthesizeSpeech(spoken, voiceId);
    if (!out) {
      // Cartesia was configured but the call failed: fall back honestly to browser speech.
      return {
        ok: false,
        mode: "sandbox",
        spoken,
        playback: "browser-speech-synthesis",
        detail: "Cartesia call did not return audio; falling back to the browser's SpeechSynthesis.",
      };
    }
    const audioBase64 = Buffer.from(out.audio).toString("base64");
    return {
      ok: true,
      mode: "live",
      spoken,
      audioBase64,
      contentType: out.contentType,
      playback: "cartesia-audio",
      detail: "Live: Cartesia synthesized the spoken reply.",
    };
  }
}

const VOICE_KEY = "__Sahaya_cartesia_voice__";

export function getVoiceProvider(): VoiceProvider {
  const g = globalThis as Record<string, unknown>;
  if (g[VOICE_KEY]) return g[VOICE_KEY] as VoiceProvider;
  const provider = cartesiaStatus().mode === "live" ? new CartesiaVoiceProvider() : new SandboxVoiceProvider();
  g[VOICE_KEY] = provider;
  return provider;
}

export function setVoiceProvider(p: VoiceProvider): void {
  (globalThis as Record<string, unknown>)[VOICE_KEY] = p;
}
export function resetVoiceProvider(): void {
  delete (globalThis as Record<string, unknown>)[VOICE_KEY];
}
