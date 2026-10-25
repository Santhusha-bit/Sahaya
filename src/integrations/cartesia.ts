import { cartesiaStatus } from "@/lib/env";

/**
 * Cartesia text-to-speech. Returns MP3 bytes when a key is configured, otherwise
 * null so the client falls back to the browser's SpeechSynthesis. Honestly
 * reported via cartesiaStatus().
 */
export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
): Promise<{ audio: ArrayBuffer; contentType: string } | null> {
  if (cartesiaStatus().mode !== "live") return null;
  const apiKey = process.env.CARTESIA_API_KEY!;
  const voice = voiceId || process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091";

  try {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "Cartesia-Version": "2024-11-13",
      },
      body: JSON.stringify({
        model_id: "sonic-2",
        transcript: text.slice(0, 2000),
        voice: { mode: "id", id: voice },
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        language: "en",
      }),
    });
    if (!res.ok) {
      console.warn("Cartesia TTS failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    return { audio: await res.arrayBuffer(), contentType: "audio/mpeg" };
  } catch (err) {
    console.warn("Cartesia TTS error:", err);
    return null;
  }
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
      detail: "Sandbox — no Cartesia key; the client speaks this with the browser's SpeechSynthesis.",
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
      detail: "Live — Cartesia synthesized the spoken reply.",
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
