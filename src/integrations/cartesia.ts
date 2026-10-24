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
