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
