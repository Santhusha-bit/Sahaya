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

/** Speak text: Cartesia via /api/voice when configured, else browser synth. */
export async function speak(text: string): Promise<"cartesia" | "browser" | "none"> {
  try {
    const res = await fetch("/api/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.status === 200) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play().catch(() => {});
      audio.onended = () => URL.revokeObjectURL(url);
      return "cartesia";
    }
  } catch {
    /* fall through to browser */
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.98;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return "browser";
  }
  return "none";
}
