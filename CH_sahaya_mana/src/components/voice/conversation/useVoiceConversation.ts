"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentId } from "@/agents/base/types";
import { DEFAULT_TURN_CONFIG, initialTurnModel, turnReducer, type TurnEffect, type TurnEvent, type TurnModel } from "@/lib/voice/turnMachine";
import { MicPermissionError, PcmPlayer, startMicCapture, type MicCapture } from "./audio";
import {
  browserSpeechSupported,
  mintToken,
  openBrowserStt,
  openBrowserTts,
  openCartesiaStt,
  openCartesiaTts,
  type SttStream,
  type TtsStream,
} from "./streams";
import type { StreamConfig } from "@/integrations/cartesia";

export type ConversationProvider = "cartesia" | "browser";

export interface ConversationTurn {
  user: string;
  reply: string;
}

/**
 * Hands-free voice conversation with one agent. Turn-taking rules live in the pure turnReducer; this hook
 * wires audio, streams and the existing message route (/api/agents/[agent]/message with channel "voice",
 * i.e. processVoiceInput — the same permissions, approvals and deterministic checks as typed messages).
 * Voice can never approve anything: approvals stay on the on-screen Approve buttons.
 */
export function useVoiceConversation(agent: AgentId, opts: { onTurn?: (t: ConversationTurn) => void } = {}) {
  const [model, setModel] = useState<TurnModel>(initialTurnModel);
  const [provider, setProvider] = useState<ConversationProvider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const modelRef = useRef<TurnModel>(model);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const sttRef = useRef<SttStream | null>(null);
  const ttsRef = useRef<TtsStream | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const configRef = useRef<StreamConfig | null>(null);
  const providerRef = useRef<ConversationProvider | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTurnRef = useRef(opts.onTurn);
  const lastUserRef = useRef("");
  useEffect(() => {
    onTurnRef.current = opts.onTurn;
  });

  const teardown = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    micRef.current?.stop();
    micRef.current = null;
    sttRef.current?.close();
    sttRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    ttsRef.current?.close();
    ttsRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    void ctx?.close().catch(() => undefined);
    setLevel(0);
  }, []);

  // `dispatch` and `run` call each other; refs keep them stable without stale closures.
  const dispatchRef = useRef<(e: TurnEvent) => void>(() => {});

  const openStt = useCallback((token: string | null) => {
    const handlers = {
      onOpen: () => dispatchRef.current({ type: "connected", now: Date.now() }),
      onPartial: (text: string) => dispatchRef.current({ type: "partial", text, now: Date.now() }),
      onFinal: (text: string) => dispatchRef.current({ type: "final", text, now: Date.now() }),
      onClose: (error?: string) => dispatchRef.current({ type: "disconnected", now: Date.now(), error }),
    };
    sttRef.current = providerRef.current === "cartesia" && token && configRef.current ? openCartesiaStt(token, configRef.current, handlers) : openBrowserStt(handlers);
  }, []);

  const run = useCallback(
    (fx: TurnEffect) => {
      const now = () => Date.now();
      switch (fx.type) {
        case "submit": {
          lastUserRef.current = fx.text;
          void (async () => {
            try {
              const res = await fetch(`/api/agents/${agent}/message`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: fx.text, channel: "voice" }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
              onTurnRef.current?.({ user: fx.text, reply: data.reply ?? "" });
              dispatchRef.current({ type: "reply", text: data.reply ?? "", now: now() });
            } catch (err) {
              onTurnRef.current?.({ user: fx.text, reply: "" });
              dispatchRef.current({ type: "replyFailed", error: err instanceof Error ? err.message : "Couldn't reach Sahaya.", now: now() });
            }
          })();
          break;
        }
        case "speak": {
          const tts = ttsRef.current;
          if (!tts) {
            dispatchRef.current({ type: "speakingDone", now: now() });
            break;
          }
          playerRef.current?.begin();
          tts.speak(fx.text);
          break;
        }
        case "stopSpeaking":
          playerRef.current?.stop();
          ttsRef.current?.cancel();
          break;
        case "finalize":
          sttRef.current?.finalize();
          break;
        case "reconnect":
          void (async () => {
            sttRef.current?.close();
            sttRef.current = null;
            if (providerRef.current === "cartesia") {
              const t = await mintToken();
              if ("error" in t) {
                dispatchRef.current({ type: "disconnected", now: now(), error: t.error });
                return;
              }
              configRef.current = t.config;
              openStt(t.token);
            } else openStt(null);
          })();
          break;
        case "notice":
          setNotice(fx.text);
          break;
        case "close": {
          if (fx.reason === "silence" && ttsRef.current && providerRef.current === "cartesia" && playerRef.current) {
            // Say the notice in Care's voice, then hang up (bounded wait).
            const p = playerRef.current;
            p.begin();
            ttsRef.current.speak("I haven't heard anything for a while, so I've ended our conversation.");
            const timer = setTimeout(teardown, 8000);
            const prevDone = ttsDone.current;
            ttsDone.current = () => {
              prevDone?.();
              p.markFinished(() => {
                clearTimeout(timer);
                teardown();
              });
            };
          } else teardown();
          break;
        }
      }
    },
    [agent, openStt, teardown],
  );

  const ttsDone = useRef<(() => void) | null>(null);

  const dispatch = useCallback(
    (e: TurnEvent) => {
      const { model: next, effects } = turnReducer(modelRef.current, e, DEFAULT_TURN_CONFIG);
      modelRef.current = next;
      setModel(next);
      effects.forEach(run);
    },
    [run],
  );
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const start = useCallback(async () => {
    if (modelRef.current.state !== "idle" && modelRef.current.state !== "ended" && modelRef.current.state !== "error") return;
    setNotice(null);
    dispatch({ type: "start", now: Date.now() });
    // Created inside the click handler so browsers allow audio playback.
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    void ctx.resume();

    const token = await mintToken();
    const tokenStr = "error" in token ? null : token.token;
    let prov: ConversationProvider;
    if (!("error" in token)) {
      prov = "cartesia";
      configRef.current = token.config;
    } else if (browserSpeechSupported()) {
      prov = "browser";
      setNotice(`${token.error} Using your browser's speech instead (not Cartesia).`);
    } else {
      teardown();
      modelRef.current = { ...modelRef.current, reconnects: DEFAULT_TURN_CONFIG.maxReconnects };
      dispatch({ type: "disconnected", now: Date.now(), error: `${token.error} This browser has no built-in speech either.` });
      return;
    }
    providerRef.current = prov;
    setProvider(prov);

    try {
      if (prov === "cartesia") {
        const cfg = configRef.current!;
        playerRef.current = new PcmPlayer(ctx, cfg.outputSampleRate);
        ttsRef.current = await openCartesiaTts(tokenStr!, cfg, {
          onAudio: (b64) => playerRef.current?.push(b64),
          onDone: () => {
            const extra = ttsDone.current;
            ttsDone.current = null;
            if (extra) extra();
            else playerRef.current?.markFinished(() => dispatchRef.current({ type: "speakingDone", now: Date.now() }));
          },
          onError: (msg) => {
            setNotice(msg);
            playerRef.current?.stop();
            dispatchRef.current({ type: "speakingDone", now: Date.now() });
          },
        });
        micRef.current = await startMicCapture(ctx, cfg.inputSampleRate, (pcm, rms) => {
          sttRef.current?.send(pcm);
          setLevel(rms);
          dispatchRef.current({ type: "level", rms, now: Date.now() });
        });
        openStt(tokenStr);
      } else {
        ttsRef.current = openBrowserTts({
          onAudio: () => {},
          onDone: () => dispatchRef.current({ type: "speakingDone", now: Date.now() }),
          onError: () => dispatchRef.current({ type: "speakingDone", now: Date.now() }),
        });
        openStt(null);
      }
    } catch (err) {
      teardown();
      const msg = err instanceof MicPermissionError ? err.message : err instanceof Error ? err.message : "Couldn't start the conversation.";
      setNotice(msg);
      modelRef.current = { ...modelRef.current, reconnects: DEFAULT_TURN_CONFIG.maxReconnects };
      dispatch({ type: "disconnected", now: Date.now(), error: msg });
      return;
    }
    tickRef.current = setInterval(() => dispatchRef.current({ type: "tick", now: Date.now() }), 200);
  }, [dispatch, openStt, teardown]);

  const end = useCallback(() => dispatch({ type: "end", now: Date.now() }), [dispatch]);

  const toggleMute = useCallback(() => {
    const muted = !modelRef.current.muted;
    micRef.current?.setMuted(muted);
    dispatch({ type: "mute", muted, now: Date.now() });
  }, [dispatch]);

  useEffect(() => teardown, [teardown]);

  const active = ["connecting", "listening", "hearing", "thinking", "speaking"].includes(model.state);
  return {
    model,
    active,
    provider,
    // "Streaming" only once the Cartesia socket is actually open; until then it says so.
    providerLabel:
      provider === "cartesia"
        ? model.state === "connecting"
          ? "Cartesia voice (connecting…)"
          : "Cartesia voice (streaming)"
        : provider === "browser"
          ? "Browser speech (not Cartesia)"
          : null,
    notice,
    level,
    start,
    end,
    toggleMute,
  };
}
