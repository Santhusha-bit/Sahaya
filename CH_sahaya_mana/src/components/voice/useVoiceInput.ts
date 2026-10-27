"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORDING_SECONDS } from "@/integrations/voicePolicy";

/** MediaRecorder types in preference order: Chrome/Edge/Firefox record webm/ogg Opus, Safari records mp4 (AAC). */
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];

export function pickRecorderType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getRecognition(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export type VoiceInputState = "idle" | "listening" | "processing";

export interface VoiceInputCallbacks {
  /** Cartesia path: the finished recording. */
  onAudio: (audio: Blob) => Promise<void>;
  /** Browser-speech path: the browser's own transcript. */
  onBrowserTranscript: (text: string, confidence?: number) => Promise<void>;
  onError: (message: string) => void;
}

/**
 * Tap-to-start / tap-to-stop voice input. With Cartesia it records audio (auto-stops at 60 s); without it,
 * it uses the browser's SpeechRecognition, which the UI labels as browser speech.
 */
export function useVoiceInput(provider: "cartesia" | "browser", cb: VoiceInputCallbacks) {
  const [state, setState] = useState<VoiceInputState>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  });

  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  useEffect(
    () => () => {
      clearTimer();
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      recognitionRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    clearTimer();
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    recognitionRef.current?.stop();
  }, []);

  const startBrowser = useCallback(() => {
    const rec = getRecognition();
    if (!rec) {
      cbRef.current.onError("Voice input isn't available in this browser. Please type your message instead.");
      return;
    }
    recognitionRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let got = false;
    rec.onresult = (e) => {
      const alt = e.results[0]?.[0];
      if (!alt) return;
      got = true;
      setState("processing");
      cbRef.current.onBrowserTranscript(alt.transcript, alt.confidence).finally(() => setState("idle"));
    };
    rec.onerror = (e) => {
      cbRef.current.onError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone permission was denied. Allow the microphone in your browser settings, then try again."
          : e.error === "no-speech"
            ? "I didn't hear anything. Please try again."
            : "Browser speech recognition failed. Please try again or type.",
      );
    };
    rec.onend = () => {
      recognitionRef.current = null;
      if (!got) setState("idle");
    };
    setState("listening");
    rec.start();
  }, []);

  const startRecorder = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      startBrowser();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const name = (err as { name?: string }).name;
      cbRef.current.onError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied. Allow the microphone in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "Couldn't start the microphone.",
      );
      return;
    }
    const type = pickRecorderType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recorderRef.current = null;
      const blob = new Blob(chunks, { type: (recorder.mimeType || type || "audio/webm").split(";")[0] });
      if (blob.size === 0) {
        setState("idle");
        cbRef.current.onError("The recording was empty. Please try again.");
        return;
      }
      setState("processing");
      cbRef.current.onAudio(blob).finally(() => setState("idle"));
    };
    recorderRef.current = recorder;
    recorder.start();
    setSeconds(0);
    setState("listening");
    const started = Date.now();
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORDING_SECONDS) stop();
    }, 250);
  }, [startBrowser, stop]);

  const toggle = useCallback(() => {
    if (state === "listening") stop();
    else if (state === "idle") {
      if (provider === "cartesia") void startRecorder();
      else startBrowser();
    }
  }, [state, provider, stop, startRecorder, startBrowser]);

  return { state, seconds, toggle, stop };
}
