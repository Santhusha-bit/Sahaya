/**
 * Hands-free conversation turn-taking, as a pure reducer so every rule is testable without audio.
 *
 *   idle → connecting → listening ⇄ hearing → thinking → speaking → listening …
 *
 * - Partial/final transcripts and the local mic level mark activity. A turn is submitted only after the
 *   speech recognizer has produced final text AND there has been `turnEndMs` of quiet (so slower speakers
 *   with pauses aren't cut off). Empty and filler-only results ("um", "hmm") are ignored.
 * - While Care is speaking, meaningful speech from the user is barge-in: stop playback at once and start a
 *   new turn. Mic level alone never triggers barge-in (speaker echo would cut Care off).
 * - Submission waits while Care is thinking or speaking (no overlapping turns).
 * - After `silenceTimeoutMs` with nothing said, the conversation ends with a notice.
 * - A dropped stream reconnects once; a second drop ends with an error so the UI can fall back.
 *
 * The machine decides; the hook performs effects (send, stop audio, speak, reconnect, end).
 */

export type ConversationState = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended" | "error";

export interface TurnConfig {
  turnEndMs: number;
  finalizeAfterMs: number;
  silenceTimeoutMs: number;
  maxReconnects: number;
  levelThreshold: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  turnEndMs: 700,
  finalizeAfterMs: 1200,
  silenceTimeoutMs: 2 * 60_000,
  maxReconnects: 1,
  levelThreshold: 0.02,
};

export interface TurnModel {
  state: ConversationState;
  /** Final text gathered for the current user turn (not yet submitted). */
  turnText: string;
  /** Live, unconfirmed text (shown on screen). */
  partial: string;
  lastActivityAt: number;
  finalizeRequested: boolean;
  muted: boolean;
  reconnects: number;
  endReason: "user" | "silence" | "error" | null;
  error: string | null;
  turns: number;
}

export type TurnEvent =
  | { type: "start"; now: number }
  | { type: "connected"; now: number }
  | { type: "partial"; text: string; now: number }
  | { type: "final"; text: string; now: number }
  | { type: "level"; rms: number; now: number }
  | { type: "tick"; now: number }
  | { type: "reply"; text: string; now: number }
  | { type: "replyFailed"; error: string; now: number }
  | { type: "speakingDone"; now: number }
  | { type: "mute"; muted: boolean; now: number }
  | { type: "disconnected"; now: number; error?: string }
  | { type: "end"; now: number };

export type TurnEffect =
  | { type: "submit"; text: string }
  | { type: "stopSpeaking" }
  | { type: "speak"; text: string }
  | { type: "finalize" }
  | { type: "reconnect" }
  | { type: "notice"; text: string }
  | { type: "close"; reason: "user" | "silence" | "error" };

const FILLERS = new Set(["um", "umm", "uh", "uhh", "hmm", "hm", "mm", "mmm", "ah", "er", "erm", "oh"]);

/** True when text contains at least one real word (not just filler, punctuation or noise). */
export function isMeaningful(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.some((w) => w.replace(/'/g, "").length >= 2 && !FILLERS.has(w)) || words.some((w) => /^\d+$/.test(w));
}

export function initialTurnModel(): TurnModel {
  return {
    state: "idle",
    turnText: "",
    partial: "",
    lastActivityAt: 0,
    finalizeRequested: false,
    muted: false,
    reconnects: 0,
    endReason: null,
    error: null,
    turns: 0,
  };
}

const live = (s: ConversationState) => s === "listening" || s === "hearing" || s === "thinking" || s === "speaking";

export function turnReducer(m: TurnModel, e: TurnEvent, cfg: TurnConfig = DEFAULT_TURN_CONFIG): { model: TurnModel; effects: TurnEffect[] } {
  const fx: TurnEffect[] = [];
  const done = (model: TurnModel) => ({ model, effects: fx });

  switch (e.type) {
    case "start":
      return done({ ...initialTurnModel(), state: "connecting", lastActivityAt: e.now });

    case "connected":
      if (m.state !== "connecting") return done(m);
      return done({ ...m, state: m.turnText ? "hearing" : "listening", lastActivityAt: e.now, error: null });

    case "partial":
    case "final": {
      if (!live(m.state) || m.muted) return done(m);
      const meaningful = isMeaningful(e.text);
      const next: TurnModel = { ...m };
      if (meaningful) {
        next.lastActivityAt = e.now;
        if (m.state === "speaking") {
          // Barge-in: she started talking over Care — stop playback right away.
          fx.push({ type: "stopSpeaking" });
          next.state = "hearing";
        } else if (m.state === "listening") next.state = "hearing";
      }
      if (e.type === "partial") {
        next.partial = meaningful ? e.text : next.partial;
      } else {
        next.partial = "";
        next.finalizeRequested = false;
        if (meaningful) next.turnText = `${next.turnText}${e.text}`.replace(/\s+/g, " ").trimStart();
      }
      return done(next);
    }

    case "level": {
      if (!live(m.state) || m.muted || e.rms < cfg.levelThreshold) return done(m);
      // Voice energy keeps a turn open while she is mid-sentence, but never interrupts Care on its own.
      if (m.state === "speaking" || m.state === "thinking") return done(m);
      return done({ ...m, lastActivityAt: e.now, state: m.state === "listening" ? "hearing" : m.state });
    }

    case "tick": {
      if (!live(m.state)) return done(m);
      const quiet = e.now - m.lastActivityAt;
      if ((m.state === "listening" || m.state === "hearing") && !m.muted) {
        if (m.partial && !m.finalizeRequested && quiet >= cfg.finalizeAfterMs) {
          fx.push({ type: "finalize" });
          return done({ ...m, finalizeRequested: true });
        }
        if (m.turnText.trim() && !m.partial && quiet >= cfg.turnEndMs) {
          fx.push({ type: "submit", text: m.turnText.trim() });
          return done({ ...m, state: "thinking", turnText: "", partial: "", turns: m.turns + 1 });
        }
        if (!m.turnText.trim() && !m.partial && m.state === "hearing" && quiet >= cfg.turnEndMs * 3) {
          return done({ ...m, state: "listening" }); // noise that never became words
        }
      }
      if ((m.state === "listening" || m.state === "hearing") && !m.turnText && !m.partial && quiet >= cfg.silenceTimeoutMs) {
        fx.push({ type: "notice", text: "I haven't heard anything for a while, so I've ended our conversation. Tap Start conversation to talk again." });
        fx.push({ type: "close", reason: "silence" });
        return done({ ...m, state: "ended", endReason: "silence" });
      }
      return done(m);
    }

    case "reply": {
      if (m.state !== "thinking") return done(m);
      if (!e.text.trim()) return done({ ...m, state: m.turnText ? "hearing" : "listening", lastActivityAt: e.now });
      fx.push({ type: "speak", text: e.text });
      return done({ ...m, state: "speaking", lastActivityAt: e.now });
    }

    case "replyFailed":
      if (m.state !== "thinking") return done(m);
      fx.push({ type: "notice", text: e.error });
      return done({ ...m, state: "listening", lastActivityAt: e.now, error: e.error });

    case "speakingDone":
      if (m.state !== "speaking") return done(m);
      return done({ ...m, state: m.turnText ? "hearing" : "listening", lastActivityAt: e.now });

    case "mute":
      return done({ ...m, muted: e.muted, partial: e.muted ? "" : m.partial, lastActivityAt: e.now });

    case "disconnected": {
      if (m.state === "ended" || m.state === "idle" || m.state === "error") return done(m);
      if (m.reconnects < cfg.maxReconnects) {
        fx.push({ type: "reconnect" });
        return done({ ...m, state: "connecting", reconnects: m.reconnects + 1, partial: "" });
      }
      const error = e.error ?? "The voice connection dropped.";
      fx.push({ type: "notice", text: `${error} Voice conversation ended.` });
      fx.push({ type: "close", reason: "error" });
      return done({ ...m, state: "error", endReason: "error", error });
    }

    case "end":
      if (m.state === "ended" || m.state === "idle") return done(m);
      if (m.state === "speaking") fx.push({ type: "stopSpeaking" });
      fx.push({ type: "close", reason: "user" });
      return done({ ...m, state: "ended", endReason: "user", partial: "", turnText: "" });
  }
}
