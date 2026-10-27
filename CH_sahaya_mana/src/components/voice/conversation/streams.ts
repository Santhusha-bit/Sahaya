"use client";

import { chunkForSpeech } from "@/integrations/voicePolicy";
import { sttStreamUrl, ttsStreamRequest, ttsStreamUrl, type StreamConfig } from "@/integrations/cartesia";

/**
 * Speech streams for a hands-free conversation. Two interchangeable implementations:
 *  - Cartesia: browser WebSockets authenticated with a short-lived access token from /api/voice/token.
 *  - Browser: continuous SpeechRecognition + speechSynthesis, always labelled "Browser speech (not Cartesia)".
 */

export interface SttHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onOpen(): void;
  onClose(error?: string): void;
}

export interface SttStream {
  send(pcm: ArrayBuffer): void;
  finalize(): void;
  close(): void;
}

export interface TtsHandlers {
  onAudio(base64: string): void;
  onDone(): void;
  onError(error: string): void;
}

export interface TtsStream {
  speak(text: string): string;
  cancel(): void;
  close(): void;
}

export async function mintToken(): Promise<{ token: string; config: StreamConfig } | { error: string; code?: string }> {
  try {
    const res = await fetch("/api/voice/token", { method: "POST" });
    const body = await res.json();
    if (!res.ok) return { error: body.error ?? "Couldn't start Cartesia streaming.", code: body.code };
    return { token: body.token, config: body.config };
  } catch {
    return { error: "Couldn't reach Sahaya to start voice streaming.", code: "NETWORK" };
  }
}

export function reportStream(ok: boolean, kind: string) {
  void fetch("/api/voice/stream-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok, kind }),
  }).catch(() => undefined);
}

export function openCartesiaStt(token: string, config: StreamConfig, h: SttHandlers): SttStream {
  const ws = new WebSocket(sttStreamUrl(token, config));
  ws.binaryType = "arraybuffer";
  let closedByUs = false;
  let reportedTranscript = false;
  ws.onopen = () => {
    reportStream(true, "stt_open");
    h.onOpen();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let msg: { type?: string; is_final?: boolean; text?: string; status_code?: number; title?: string };
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "transcript" && typeof msg.text === "string") {
      if (!reportedTranscript && msg.text.trim()) {
        reportedTranscript = true;
        reportStream(true, "stt_transcript");
      }
      if (msg.is_final) h.onFinal(msg.text);
      else h.onPartial(msg.text);
    } else if (msg.type === "error") {
      const auth = msg.status_code === 401 || msg.status_code === 403;
      reportStream(false, auth ? "auth" : "stt_error");
      h.onClose(auth ? "Cartesia rejected the voice token." : `Cartesia speech recognition error${msg.title ? `: ${msg.title}` : ""}.`);
      closedByUs = true;
      ws.close();
    }
  };
  ws.onclose = () => {
    if (!closedByUs) {
      reportStream(false, "network");
      h.onClose("The voice connection dropped.");
    }
  };
  return {
    send(pcm) {
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
    },
    finalize() {
      if (ws.readyState === WebSocket.OPEN) ws.send("finalize");
    },
    close() {
      closedByUs = true;
      if (ws.readyState === WebSocket.OPEN) ws.send("close");
      setTimeout(() => ws.close(), 300);
    },
  };
}

export function openCartesiaTts(token: string, config: StreamConfig, h: TtsHandlers): Promise<TtsStream> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ttsStreamUrl(token, config));
    let current: string | null = null;
    let reported = false;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        speak(text) {
          const id = crypto.randomUUID();
          current = id;
          const parts = chunkForSpeech(text, 500);
          parts.forEach((p, i) => ws.send(JSON.stringify(ttsStreamRequest(config, id, p, i < parts.length - 1))));
          return id;
        },
        cancel() {
          if (current && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ context_id: current, cancel: true }));
          current = null;
        },
        close() {
          current = null;
          ws.close();
        },
      });
    };
    ws.onmessage = (e) => {
      let msg: { type?: string; data?: string; context_id?: string; done?: boolean; status_code?: number; title?: string };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.context_id && msg.context_id !== current) return; // a cancelled generation
      if (msg.type === "chunk" && msg.data) {
        if (!reported) {
          reported = true;
          reportStream(true, "tts_audio");
        }
        h.onAudio(msg.data);
      } else if (msg.type === "done") {
        h.onDone();
      } else if (msg.type === "error") {
        reportStream(false, msg.status_code === 401 || msg.status_code === 403 ? "auth" : "tts_error");
        h.onError(`Cartesia voice error${msg.title ? `: ${msg.title}` : ""}.`);
      }
    };
    ws.onerror = () => {
      if (!opened) reject(new Error("Couldn't open the Cartesia voice stream."));
    };
  });
}

// ── Browser fallback ───────────────────────────────────────────────────────

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export function browserSpeechSupported() {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition) && "speechSynthesis" in window;
}

export function openBrowserStt(h: SttHandlers): SttStream {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition)!;
  let stopped = false;
  let rec: Rec;
  const begin = () => {
    rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) h.onFinal(` ${r[0].transcript}`);
        else h.onPartial(r[0].transcript);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        stopped = true;
        h.onClose("Microphone permission was denied. Allow the microphone in your browser settings, then try again.");
      }
    };
    // Browsers end continuous recognition periodically; restart it until the conversation ends.
    rec.onend = () => {
      if (!stopped) setTimeout(() => !stopped && begin(), 250);
    };
    rec.start();
  };
  begin();
  setTimeout(() => h.onOpen(), 0);
  return {
    send() {},
    finalize() {},
    close() {
      stopped = true;
      rec.abort();
    },
  };
}

export function openBrowserTts(h: TtsHandlers): TtsStream {
  return {
    speak(text) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.9;
      u.onend = () => h.onDone();
      u.onerror = () => h.onDone();
      window.speechSynthesis.speak(u);
      return "browser";
    },
    cancel() {
      window.speechSynthesis.cancel();
    },
    close() {
      window.speechSynthesis.cancel();
    },
  };
}
