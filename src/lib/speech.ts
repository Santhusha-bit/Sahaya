"use client";

/** Browser speech helpers with graceful fallback (used by the voice UI). */

export function speechRecognitionSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "webkitSpeechRecognition" in window || "SpeechRecognition" in window;
}

export interface Recognizer {
  start: () => void;
  stop: () => void;
}

export function createRecognizer(opts: {
  onResult: (transcript: string) => void;
  onEnd: () => void;
  onError?: (e: string) => void;
}): Recognizer | null {
  if (!speechRecognitionSupported()) return null;
  const Ctor = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  rec.onresult = (e: any) => {
    const transcript = e.results[0][0].transcript as string;
    opts.onResult(transcript);
  };
  rec.onend = () => opts.onEnd();
  rec.onerror = (e: any) => opts.onError?.(e.error ?? "error");
  return { start: () => rec.start(), stop: () => rec.stop() };
}

/**
 * Continuous recognizer for live call captions: emits each final phrase and
 * restarts itself when the browser ends the session, until stop() is called.
 */
export function createCaptionRecognizer(opts: {
  onPhrase: (text: string) => void;
  onError?: (e: string) => void;
}): Recognizer | null {
  if (!speechRecognitionSupported()) return null;
  const Ctor = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
  const rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.continuous = true;
  let active = false;
  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        const text = (e.results[i][0].transcript as string).trim();
        if (text) opts.onPhrase(text);
      }
    }
  };
  rec.onend = () => {
    if (active) rec.start();
  };
  rec.onerror = (e: any) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") active = false;
    opts.onError?.(e.error ?? "error");
  };
  return {
    start: () => {
      active = true;
      rec.start();
    },
    stop: () => {
      active = false;
      rec.stop();
    },
  };
}

export type VoicePersona = "guardian" | "scam-caller";

/** Fetch Cartesia MP3 bytes for a line, or null when Cartesia isn't configured. */
export async function fetchSpeechAudio(text: string, persona?: VoicePersona): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, persona }),
    });
    return res.status === 200 ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Browser SpeechSynthesis; resolves when the utterance finishes. */
export function speakWithBrowser(text: string, opts: { rate?: number; pitch?: number } = {}): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = opts.rate ?? 0.98;
    if (opts.pitch) u.pitch = opts.pitch;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

/**
 * Speak text: Cartesia via /api/voice when configured, else browser synth.
 * With `wait`, resolves only after playback ends (used to pace the demo call).
 */
export async function speak(
  text: string,
  opts: { persona?: VoicePersona; wait?: boolean } = {},
): Promise<"cartesia" | "browser" | "none"> {
  const audioBytes = await fetchSpeechAudio(text, opts.persona);
  if (audioBytes) {
    const url = URL.createObjectURL(new Blob([audioBytes], { type: "audio/mpeg" }));
    const audio = new Audio(url);
    const ended = new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
    }).finally(() => URL.revokeObjectURL(url));
    const played = await audio.play().then(
      () => true,
      () => false,
    );
    if (opts.wait && played) await ended;
    return "cartesia";
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    const done = speakWithBrowser(text);
    if (opts.wait) await done;
    return "browser";
  }
  return "none";
}
