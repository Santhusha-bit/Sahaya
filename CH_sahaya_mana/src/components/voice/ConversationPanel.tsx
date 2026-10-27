"use client";

import { forwardRef, useEffect, useImperativeHandle } from "react";
import type { AgentId } from "@/agents/base/types";
import type { ConversationState } from "@/lib/voice/turnMachine";
import { AGENT_THEME } from "@/components/agents/agentTheme";
import { useVoiceConversation, type ConversationTurn } from "./conversation/useVoiceConversation";

const STATE_TEXT: Record<ConversationState, { title: string; hint: string }> = {
  idle: { title: "Ready", hint: "" },
  connecting: { title: "Connecting…", hint: "Getting the microphone ready." },
  listening: { title: "Listening", hint: "Just talk. I'll answer when you pause." },
  hearing: { title: "Hearing you…", hint: "Take your time." },
  thinking: { title: "Thinking…", hint: "One moment." },
  speaking: { title: "Speaking", hint: "Start talking any time to interrupt." },
  ended: { title: "Conversation ended", hint: "" },
  error: { title: "Voice stopped", hint: "" },
};

/**
 * Hands-free conversation controls for the agent console: Start, live transcript, big state banner,
 * Mute and End. Approvals are never given by voice — the agent will ask you to tap Approve.
 */
export interface ConversationPanelHandle {
  start: () => Promise<void>;
  end: () => void;
}

export const ConversationPanel = forwardRef<ConversationPanelHandle, {
  agent: AgentId;
  name: string;
  onTurn: (t: ConversationTurn) => void;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
}>(function ConversationPanel({ agent, name, onTurn, disabled, onActiveChange }, ref) {
  const theme = AGENT_THEME[agent];
  const c = useVoiceConversation(agent, { onTurn });
  const s = STATE_TEXT[c.model.state];
  useImperativeHandle(ref, () => ({
    start: async () => { if (!disabled && !c.active) await c.start(); },
    end: c.end,
  }), [disabled, c]);
  useEffect(() => { onActiveChange?.(c.active); }, [c.active, onActiveChange]);

  if (!c.active) {
    if (!c.notice) return null;
    return (
      <div className="mx-4 mb-3 flex flex-col gap-2">
        {c.notice && (
          <p role="status" className="rounded-2xl bg-[#fdf3dc] p-4 text-lg text-warn">
            {c.notice}
          </p>
        )}

      </div>
    );
  }

  const live = [c.model.turnText, c.model.partial].filter(Boolean).join(" ").trim();
  return (
    <section aria-label={`Voice conversation with ${name}`} className={`mx-4 mb-3 rounded-[var(--radius-card)] border-2 ${theme.border} bg-surface p-4 shadow-sm`}>
      <div aria-live="assertive" role="status">
        <p className={`text-3xl font-bold ${c.model.state === "hearing" ? "text-danger" : theme.text}`}>{s.title}</p>
        <p className="text-lg text-ink-muted">{c.model.muted ? "Microphone is muted." : s.hint}</p>
      </div>
      <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-canvas" aria-hidden>
        <div className={`h-full ${theme.bg} transition-[width] duration-100`} style={{ width: `${Math.min(100, Math.round(c.level * 600))}%` }} />
      </div>
      {live && (
        <p className="mt-3 rounded-2xl bg-canvas p-3 text-xl leading-relaxed" aria-live="polite">
          “{live}”
        </p>
      )}
      {c.notice && <p className="mt-3 rounded-2xl bg-[#fdf3dc] p-3 text-lg text-warn">{c.notice}</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <button onClick={c.end} className="min-h-16 flex-1 rounded-full bg-danger px-6 text-xl font-bold text-white">
          End conversation
        </button>
        <button
          onClick={c.toggleMute}
          aria-pressed={c.model.muted}
          className="min-h-16 rounded-full border-2 border-line bg-surface px-6 text-xl font-bold text-ink"
        >
          {c.model.muted ? "Unmute mic" : "Mute mic"}
        </button>
      </div>
      <p className="mt-3 text-base text-ink-muted">
        {c.providerLabel?.includes("Browser") ? "Browser speech (not Cartesia). " : ""}Anything that needs an OK still needs you to tap Approve.
      </p>
    </section>
  );
});
