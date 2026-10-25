"use client";

import { chunkForSpeech } from "@/integrations/voicePolicy";

export type SpeechProvider = "cartesia" | "browser";

export interface VoiceStatusInfo {
  provider: SpeechProvider;
  mode: "live" | "unavailable";
  rejected: boolean;
  label: string;
  detail: string;
}

export async function fetchVoiceStatus(): Promise<VoiceStatusInfo | null> {
  try {
    const res = await fetch("/api/voice/status", { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export interface SpeakHandle {
  stop(): void;
  /** Resolves when playback ends or is stopped. `provider` is what actually spoke. */
  done: Promise<{ provider: SpeechProvider | null; error?: string; cartesiaRejected?: boolean }>;
}

export function browserSpeechAvailable() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function speakWithBrowser(text: string, isStopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (!browserSpeechAvailable() || isStopped()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.9; // a little slower, for clarity
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}


// ── Autoplay unlock ─────────────────────────────────────────────────────────
// Browsers only let a page start sound inside a user gesture. Replies arrive seconds after the tap/typing that
// caused them, so a fresh `new Audio().play()` then is blocked (Safari always, Chrome sometimes). Instead we
// create one AudioContext and resume it during the first gesture on the page; once running, it can play any
// later audio without another gesture.
let sharedCtx: AudioContext | null = null;
let unlockInstalled = false;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!sharedCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/** Resume the shared audio context inside a user gesture (also primes browser speech on Safari). */
export function unlockAudio() {
  const ctx = audioContext();
  if (ctx && ctx.state !== "running") {
    void ctx.resume().catch(() => undefined);
    // A one-sample silent buffer is what iOS Safari needs to fully unlock output.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  }
  if (browserSpeechAvailable() && !window.speechSynthesis.speaking) {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
}

/** Install page-wide listeners that unlock audio on any tap, click or key press. Safe to call repeatedly. */
export function installAudioUnlock() {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  // Kept for the page's lifetime: Safari can suspend the context again (e.g. after a phone call).
  const handler = () => unlockAudio();
  for (const ev of ["pointerdown", "keydown", "touchend"]) window.addEventListener(ev, handler, true);
}

/** Play an encoded audio clip through the unlocked context; false if the context can't play right now. */
async function playThroughContext(blob: Blob, register: (stop: () => void) => void): Promise<boolean> {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
  if (ctx.state !== "running") return false;
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => resolve();
    register(() => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      resolve();
    });
    src.start();
  });
  return true;
}

/**
 * Speak text aloud. Uses Cartesia through /api/voice/speak when preferred and working; otherwise (or if a
 * call fails) the browser's built-in speech, and reports which one was used so the UI can label it.
 */
export function speak(text: string, opts: { preferCartesia: boolean; onProvider?: (p: SpeechProvider) => void }): SpeakHandle {
  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let stopContext: (() => void) | null = null;
  const stop = () => {
    stopped = true;
    stopContext?.();
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (browserSpeechAvailable()) window.speechSynthesis.cancel();
  };

  const done = (async () => {
    let useCartesia = opts.preferCartesia;
    let used: SpeechProvider | null = null;
    let error: string | undefined;
    let cartesiaRejected = false;
    for (const chunk of chunkForSpeech(text)) {
      if (stopped) break;
      if (useCartesia) {
        try {
          const res = await fetch("/api/voice/speak", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: chunk }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            cartesiaRejected = body.code === "CARTESIA_AUTH";
            error = body.error ?? "Cartesia voice failed";
            useCartesia = false;
          } else {
            const blob = await res.blob();
            if (stopped) break;
            if (used !== "cartesia") opts.onProvider?.("cartesia");
            used = "cartesia";
            // Preferred path: the gesture-unlocked AudioContext, which can play long after the tap.
            if (await playThroughContext(blob, (s) => (stopContext = s))) {
              stopContext = null;
              continue;
            }
            if (stopped) break;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = URL.createObjectURL(blob);
            audio = new Audio(objectUrl);
            let blocked = false;
            await new Promise<void>((resolve) => {
              audio!.onended = () => resolve();
              audio!.onerror = () => resolve();
              audio!.onpause = () => resolve();
              audio!.play().catch(() => {
                blocked = true;
                resolve();
              });
            });
            if (!blocked) continue;
            // Still blocked: say this part with the browser's voice rather than asking for a tap.
            useCartesia = false;
          }
        } catch {
          error = "Couldn't reach the voice service";
          useCartesia = false;
        }
      }
      if (stopped) break;
      if (!browserSpeechAvailable()) {
        error ??= "This browser can't speak text aloud";
        break;
      }
      if (used !== "browser") opts.onProvider?.("browser");
      used = "browser";
      await speakWithBrowser(chunk, () => stopped);
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return { provider: used, error, cartesiaRejected };
  })();

  return { stop, done };
}
