/**
 * Request limits and validation for the voice routes. Pure functions so they can be tested without a
 * server. Audio and text are user content: they are validated here and never logged.
 */

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // ~10 MB
export const MAX_RECORDING_SECONDS = 60; // enforced by the recorder; checked again against Cartesia's reported duration
export const MAX_REPORTED_SECONDS = 75; // small allowance for container padding
export const MAX_SPEAK_CHARS = 1000;

/** MIME types MediaRecorder produces (Chrome/Firefox: webm/ogg opus; Safari: mp4/aac) plus common files Cartesia accepts. */
const ALLOWED_AUDIO = new Map<string, string>([
  ["audio/webm", "webm"],
  ["video/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "mp4"],
  ["video/mp4", "mp4"],
  ["audio/x-m4a", "m4a"],
  ["audio/m4a", "m4a"],
  ["audio/aac", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/flac", "flac"],
]);

export type AudioCheck = { ok: true; extension: string; baseType: string } | { ok: false; status: 400 | 413 | 415; code: string; message: string };

export function checkAudioUpload(file: { size: number; type: string } | null | undefined): AudioCheck {
  if (!file) return { ok: false, status: 400, code: "NO_AUDIO", message: "No audio was received." };
  if (file.size === 0) return { ok: false, status: 400, code: "EMPTY_AUDIO", message: "The recording was empty. Please try again." };
  if (file.size > MAX_AUDIO_BYTES) {
    return { ok: false, status: 413, code: "AUDIO_TOO_LARGE", message: `Recordings can be up to ${MAX_RECORDING_SECONDS} seconds.` };
  }
  const baseType = file.type.split(";")[0].trim().toLowerCase();
  const extension = ALLOWED_AUDIO.get(baseType);
  if (!extension) return { ok: false, status: 415, code: "UNSUPPORTED_AUDIO", message: "That audio format isn't supported." };
  return { ok: true, extension, baseType };
}

export type TextCheck = { ok: true; text: string } | { ok: false; status: 400 | 413; code: string; message: string };

/**
 * Plain text for speech: strips markup/markdown symbols and control characters, collapses whitespace.
 * Rejects empty or over-long input rather than silently truncating.
 */
export function prepareSpeechText(raw: unknown): TextCheck {
  if (typeof raw !== "string") return { ok: false, status: 400, code: "NO_TEXT", message: "Nothing to say." };
  const text = raw
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>|~]+/g, " ")
    .replace(/\[([^\]]{0,200})\]\([^)]{0,500}\)/g, "$1")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { ok: false, status: 400, code: "NO_TEXT", message: "Nothing to say." };
  if (text.length > MAX_SPEAK_CHARS) {
    return { ok: false, status: 413, code: "TEXT_TOO_LONG", message: `Speech is limited to ${MAX_SPEAK_CHARS} characters per request.` };
  }
  return { ok: true, text };
}

/** Split a long reply into ≤ max-char chunks at sentence boundaries (used by the browser before calling /speak). */
export function chunkForSpeech(text: string, max = MAX_SPEAK_CHARS): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    const piece = s.length > max ? s.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) ?? [s.slice(0, max)] : [s];
    for (const p of piece) {
      if ((current + " " + p).trim().length > max) {
        if (current) chunks.push(current.trim());
        current = p;
      } else current = `${current} ${p}`;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
