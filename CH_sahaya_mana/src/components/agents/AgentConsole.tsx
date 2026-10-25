"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentId, AgentTask } from "@/agents/base/types";
import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { AgentIcon, BackIcon, MicIcon, SendIcon } from "@/components/icons";
import { Card, EmptyState, ModeBadge, Section } from "@/components/ui";
import { fetchVoiceStatus, installAudioUnlock, speak, type SpeakHandle, type SpeechProvider, type VoiceStatusInfo } from "@/components/voice/speech";
import { useVoiceInput } from "@/components/voice/useVoiceInput";
import { ConversationPanel, type ConversationPanelHandle } from "@/components/voice/ConversationPanel";
import { createMicPress } from "@/lib/voice/micPress";
import { AGENT_THEME } from "./agentTheme";

export interface AgentConsoleProps {
  agent: AgentId;
  name: string;
  tagline: string;
  welcome: string;
  suggestions: string[];
  skills: Array<{ name: string; description: string; needsApproval: boolean }>;
  integrations: Array<{ id: IntegrationId; name: string; mode: IntegrationMode; detail: string }>;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  channel: string;
}
interface PendingApproval {
  id: string;
  summary: string;
  expiresAt: number;
}

const STATUS_LABEL: Record<AgentTask["status"], string> = {
  planned: "Planned",
  running: "In progress",
  awaiting_approval: "Waiting for your OK",
  completed: "Done",
  failed: "Didn't finish",
  cancelled: "Cancelled",
};

export function AgentConsole(props: AgentConsoleProps) {
  const { agent, name, tagline, welcome, suggestions, skills, integrations } = props;
  const theme = AGENT_THEME[agent];
  const claude = integrations.find((i) => i.id === "claude");
  const voiceInfo = integrations.find((i) => i.id === "cartesia");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Voice: Cartesia when the server says it's live, otherwise the browser's own speech (labelled).
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatusInfo | null>(null);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [speaking, setSpeaking] = useState<SpeechProvider | null>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const speakRef = useRef<SpeakHandle | null>(null);
  const voiceProvider: SpeechProvider = voiceStatus?.provider ?? "browser";

  useEffect(() => {
    installAudioUnlock();
    fetchVoiceStatus().then((v) => v && setVoiceStatus(v));
    // Remembered per device; read after mount to keep server and client markup identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoSpeak((window.localStorage.getItem("sahaya.autoSpeak") ?? window.localStorage.getItem("kinline.autoSpeak")) !== "off"); // kinline.*: pre-rename key
    return () => speakRef.current?.stop();
  }, []);

  const switchToBrowserSpeech = useCallback((detail: string) => {
    setVoiceStatus((v) => ({
      provider: "browser",
      mode: "unavailable",
      rejected: v?.rejected ?? false,
      label: "Browser speech (not Cartesia)",
      detail,
    }));
  }, []);

  const stopSpeaking = useCallback(() => {
    speakRef.current?.stop();
    speakRef.current = null;
    setSpeaking(null);
  }, []);

  const sayAloud = useCallback(
    (text: string) => {
      speakRef.current?.stop();
      const handle = speak(text, { preferCartesia: voiceProvider === "cartesia", onProvider: setSpeaking });
      speakRef.current = handle;
      handle.done.then((r) => {
        if (speakRef.current === handle) {
          speakRef.current = null;
          setSpeaking(null);
        }
        if (r.cartesiaRejected) switchToBrowserSpeech("Cartesia rejected the key — using your browser's speech instead.");
        if (r.error) setVoiceNote(r.provider === "browser" ? `${r.error}. Used your browser's voice instead.` : r.error);
      });
    },
    [voiceProvider, switchToBrowserSpeech],
  );

  const conversationRef = useRef<ConversationPanelHandle | null>(null);
  const [conversationActive, setConversationActive] = useState(false);
  const micPress = useMemo(() => createMicPress(), []);
  useEffect(() => () => micPress.cancel(), [micPress]);

  const refresh = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch(`/api/agents/${agent}/state`, { cache: "no-store" });
    } catch {
      setError("Couldn't reach Sahaya. Check your connection and try again.");
      return;
    }
    if (!res.ok) {
      // Signed out, sign-in not configured, or the database unavailable: say so instead of an empty chat.
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't load this conversation.");
      setNeedsSignIn(body.code === "UNAUTHENTICATED");
      return;
    }
    setNeedsSignIn(false);
    const data = await res.json();
    setMessages(data.messages);
    setTasks(data.tasks);
    setApprovals(data.approvals);
  }, [agent]);

  useEffect(() => {
    // Initial load of this agent's own state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, busy]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", text: trimmed, channel: "text" }]);
    try {
      const res = await fetch(`/api/agents/${agent}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Something went wrong.");
      else if (data.status === "llm_unavailable") setError(data.reply);
    } catch {
      setError("Couldn't reach Sahaya. Check your connection and try again.");
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  /** Shared handling of a finished voice turn (either provider). */
  async function afterVoiceTurn(transcript: string, reply: string | undefined, status: string | undefined) {
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", text: transcript, channel: "voice" }]);
    if (status === "llm_unavailable") setError(reply ?? `${name} can't answer right now.`);
    else if (reply && autoSpeak) sayAloud(reply);
  }

  const voice = useVoiceInput(voiceProvider, {
    async onAudio(audio) {
      setError(null);
      setVoiceNote(null);
      stopSpeaking();
      const form = new FormData();
      const ext = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
      form.append("audio", audio, `recording.${ext}`);
      form.append("agent", agent);
      try {
        const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) {
          if (data.code === "CARTESIA_AUTH" || data.code === "VOICE_UNAVAILABLE") {
            switchToBrowserSpeech(data.code === "CARTESIA_AUTH" ? "Cartesia rejected the key — using your browser's speech instead." : "Cartesia isn't configured — using your browser's speech.");
            setError(`${data.error}. I've switched to your browser's speech — tap the microphone to try again.`);
          } else setError(data.error ?? "Sorry, I couldn't understand the recording. Please try again.");
          return;
        }
        await afterVoiceTurn(data.transcript, data.turn?.reply, data.turn?.status);
      } catch {
        setError("Couldn't reach Sahaya. Check your connection and try again.");
      } finally {
        await refresh();
      }
    },
    async onBrowserTranscript(text, confidence) {
      setError(null);
      stopSpeaking();
      try {
        const res = await fetch(`/api/agents/${agent}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, channel: "voice", confidence }),
        });
        const data = await res.json();
        if (!res.ok) setError(data.error ?? "Something went wrong.");
        else await afterVoiceTurn(text, data.reply, data.status);
      } catch {
        setError("Couldn't reach Sahaya. Check your connection and try again.");
      } finally {
        await refresh();
      }
    },
    onError(message) {
      setError(message);
    },
  });

  async function decide(id: string, decision: "approve" | "deny") {
    setError(null);
    const res = await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Couldn't record your decision.");
    else if (data.result?.status === "error") setError(`Approved, but it didn't go through: ${data.result.error}`);
    await refresh();
  }

  const activeTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  const recentDone = tasks.filter((t) => t.status === "completed").slice(0, 3);

  return (
    <main>
      {/* Identity header — always visible so the user knows who they're talking to. */}
      <header className={`sticky top-0 z-20 ${theme.soft} border-b border-line`}>
        <div className="flex items-center gap-3 px-3 py-3">
          <Link href="/agents" aria-label="Back to all agents" className="flex h-12 w-12 items-center justify-center rounded-full">
            <BackIcon className="h-7 w-7" />
          </Link>
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl bg-surface ${theme.text}`}>
            <AgentIcon agent={agent} className="h-7 w-7" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold uppercase tracking-wide text-ink-muted">You&apos;re talking to</p>
            <h1 className={`text-2xl font-bold leading-tight ${theme.text}`}>{name}</h1>
          </div>
        </div>
      </header>

      {/* Conversation */}
      <section aria-label={`Conversation with ${name}`} className="flex flex-col gap-3 px-4 py-5" aria-live="polite">
        <Bubble role="assistant" agent={agent} onListen={() => sayAloud(welcome)}>
          {welcome}
        </Bubble>
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} agent={agent} onListen={m.role === "assistant" ? () => sayAloud(m.text) : undefined}>
            {m.text}
          </Bubble>
        ))}
        {busy && (
          <Bubble role="assistant" agent={agent}>
            <span className="text-ink-muted">{name} is working on it…</span>
          </Bubble>
        )}
        <div ref={endRef} />
      </section>

      {error && (
        <p role="alert" className="mx-4 mb-3 rounded-2xl bg-[#fde8e6] p-4 text-lg text-danger">
          {error}
          {needsSignIn && (
            <a href="/auth/login" className="ml-2 font-bold underline">
              Sign in
            </a>
          )}
        </p>
      )}

      {/* Voice status: what's happening and which voice is really being used */}
      {(voice.state !== "idle" || speaking || voiceNote) && <div aria-live="polite" className="mx-4 mb-3 flex flex-col gap-2">
        {voice.state === "listening" && (
          <p role="status" className="rounded-2xl bg-[#fde8e6] p-4 text-xl font-bold text-danger">
            Listening… tap the microphone again when you&apos;re done
            {voiceProvider === "cartesia" ? ` (${Math.floor(voice.seconds / 60)}:${String(voice.seconds % 60).padStart(2, "0")} of 1:00)` : ""}
          </p>
        )}
        {voice.state === "processing" && (
          <p role="status" className={`rounded-2xl ${theme.soft} p-4 text-xl font-bold`}>
            Thinking…
          </p>
        )}
        {speaking && (
          <div role="status" className={`flex items-center justify-between gap-3 rounded-2xl ${theme.soft} p-3`}>
            <span className="text-lg font-bold">Speaking{speaking === "browser" ? " · browser speech (not Cartesia)" : ""}</span>
            <button onClick={stopSpeaking} className="min-h-12 rounded-full bg-ink px-5 text-lg font-bold text-white">
              Stop
            </button>
          </div>
        )}
        {voiceNote && <p className="rounded-2xl bg-[#fdf3dc] p-3 text-base text-warn">{voiceNote}</p>}

      </div>}

      {/* Hands-free conversation (tap-to-record stays available on the mic button below) */}
      <ConversationPanel
        ref={conversationRef}
        onActiveChange={setConversationActive}
        agent={agent}
        name={name}
        disabled={busy || voice.state !== "idle"}
        onTurn={(t) => {
          stopSpeaking();
          setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", text: t.user, channel: "voice" }]);
          void refresh();
        }}
      />

      {/* Suggestions */}
      {messages.length === 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              disabled={busy}
              className={`min-h-12 rounded-full border-2 ${theme.border} bg-surface px-4 text-left text-base font-bold ${theme.text}`}
            >
              “{s}”
            </button>
          ))}
        </div>
      )}

      {/* Composer: voice + text */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 flex items-end gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur"
      >
        <button
          type="button"
          onPointerDown={(e) => {
            if (e.button !== 0 || busy || conversationActive || voice.state !== "idle") return;
            e.currentTarget.setPointerCapture(e.pointerId);
            micPress.down(e.clientX, e.clientY, () => {
              stopSpeaking();
              void conversationRef.current?.start();
            });
          }}
          onPointerMove={(e) => micPress.move(e.clientX, e.clientY)}
          onPointerUp={() => micPress.up()}
          onPointerCancel={() => micPress.cancel()}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.shiftKey && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              if (!e.repeat && !conversationActive && voice.state === "idle" && !busy) {
                stopSpeaking();
                void conversationRef.current?.start();
              }
            }
          }}
          onClick={() => {
            if (micPress.consumeClick()) return;
            if (conversationActive) conversationRef.current?.end();
            else void voice.toggle();
          }}
          disabled={busy || voice.state === "processing"}
          aria-pressed={voice.state === "listening" || conversationActive}
          aria-label={conversationActive ? "End hands-free conversation" : voice.state === "listening" ? "Stop recording and send" : `Talk to ${name}; hold for hands-free conversation, or press Shift+Enter`}
          title={conversationActive ? "End hands-free conversation" : "Tap to record; hold for hands-free conversation (Shift+Enter with keyboard)"}
          className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40 ${
            (voice.state === "listening" || conversationActive) ? "bg-danger ring-4 ring-[#fde8e6]" : theme.bg
          }`}
        >
          {(voice.state === "listening" || conversationActive) ? <span aria-hidden className="block h-6 w-6 rounded-md bg-white" /> : <MicIcon className="h-8 w-8" />}
        </button>
        <label className="sr-only" htmlFor="composer">
          Message {name}
        </label>
        <textarea
          id="composer"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          placeholder="Type a message…"
          className="max-h-40 min-h-16 flex-1 resize-none rounded-3xl border-2 border-line bg-surface px-4 py-4 text-lg outline-none focus:border-brand"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          aria-label="Send"
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-ink text-white disabled:opacity-30"
        >
          <SendIcon className="h-7 w-7" />
        </button>
      </form>

      {/* Pending approvals */}
      <Section title="Waiting for your OK">
        {approvals.length === 0 ? (
          <EmptyState>Nothing needs your approval right now.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {approvals.map((a) => (
              <li key={a.id}>
                <Card className={`border-l-8 ${theme.border}`}>
                  <p className="text-lg font-bold">{a.summary}</p>
                  <p className="mt-1 text-base text-ink-muted">
                    Expires {new Date(a.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button onClick={() => decide(a.id, "approve")} className={`min-h-12 flex-1 rounded-full ${theme.bg} text-lg font-bold text-white`}>
                      Approve
                    </button>
                    <button onClick={() => decide(a.id, "deny")} className="min-h-12 flex-1 rounded-full border-2 border-line bg-surface text-lg font-bold">
                      Decline
                    </button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Tasks */}
      <Section title="Active tasks">
        {activeTasks.length === 0 ? (
          <EmptyState>No tasks in progress.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {activeTasks.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </ul>
        )}
        {recentDone.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {recentDone.map((t) => (
              <li key={t.id} className="flex justify-between gap-3 text-base text-ink-muted">
                <span className="truncate">✓ {t.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Status cards */}
      <Section title={`What ${name} can do`}>
        <p className="mb-3 text-lg text-ink-muted">{tagline}</p>
        <ul className="grid gap-2">
          {skills.map((s) => (
            <li key={s.name} className="rounded-2xl bg-surface p-3 shadow-sm">
              <p className="font-bold">{humanize(s.name)}</p>
              <p className="text-base text-ink-muted">{s.description}</p>
              {s.needsApproval && <p className={`mt-1 text-sm font-bold ${theme.text}`}>Asks for your OK first</p>}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Connections">
        <ul className="grid gap-2">
          {[claude, voiceInfo, ...integrations.filter((i) => i.id !== "claude" && i.id !== "cartesia")]
            .filter((i): i is NonNullable<typeof i> => Boolean(i))
            .map((i) => (
              <li key={i.id} className="flex items-start justify-between gap-3 rounded-2xl bg-surface p-3 shadow-sm">
                <span>
                  <span className="block font-bold">{i.name}</span>
                  <span className="block text-base text-ink-muted">{i.detail}</span>
                </span>
                <ModeBadge mode={i.mode} />
              </li>
            ))}
        </ul>
      </Section>
    </main>
  );
}

function Bubble({
  role,
  agent,
  children,
  onListen,
}: {
  role: "user" | "assistant";
  agent: AgentId;
  children: React.ReactNode;
  onListen?: () => void;
}) {
  const theme = AGENT_THEME[agent];
  const mine = role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap rounded-3xl px-5 py-3 text-lg leading-relaxed ${
          mine ? "rounded-br-md bg-ink text-white" : `rounded-bl-md bg-surface shadow-sm border-l-4 ${theme.border}`
        }`}
      >
        {children}
      </p>
      {onListen && (
        <button onClick={onListen} className={`mt-1 min-h-12 rounded-full px-4 text-base font-bold ${theme.text}`} aria-label="Listen to this message">
          ▶ Listen
        </button>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: AgentTask }) {
  return (
    <li>
      <Card>
        <div className="flex items-start justify-between gap-3">
          <p className="text-lg font-bold">{task.title}</p>
          <span className="shrink-0 rounded-full bg-canvas px-3 py-1 text-sm font-bold">{STATUS_LABEL[task.status]}</span>
        </div>
        {task.steps.length > 0 && (
          <ol className="mt-2 flex flex-col gap-1">
            {task.steps.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-base">
                <span aria-hidden>{STEP_MARK[s.status]}</span>
                <span className={s.status === "failed" ? "text-danger" : ""}>{humanize(s.toolName ?? s.description)}</span>
              </li>
            ))}
          </ol>
        )}
        {task.error && <p className="mt-2 text-base text-danger">{task.error}</p>}
      </Card>
    </li>
  );
}

const STEP_MARK: Record<string, string> = {
  pending: "○",
  running: "◐",
  awaiting_approval: "⏸",
  succeeded: "✓",
  failed: "✕",
  skipped: "–",
};

function humanize(name: string) {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
