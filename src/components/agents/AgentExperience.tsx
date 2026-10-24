"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMeta } from "@/agents/registry";
import type { AgentEvent, AgentTask, Approval, ConversationMessage, ToolCallRecord } from "@/agents/base/types";
import { AGENT_ICONS, CheckIcon, MicIcon, SendIcon, XIcon } from "@/components/icons";
import { createRecognizer, speak, speechRecognitionSupported } from "@/lib/speech";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallRecord[];
}

interface AgentStateResponse {
  tasks: AgentTask[];
  approvals: Approval[];
  history: ConversationMessage[];
  inbox: AgentEvent[];
}

export function AgentExperience({ meta }: { meta: AgentMeta }) {
  const Icon = AGENT_ICONS[meta.theme.icon] ?? AGENT_ICONS.shield;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [inbox, setInbox] = useState<AgentEvent[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const applyState = useCallback((s: AgentStateResponse) => {
    setTasks(s.tasks);
    setApprovals(s.approvals.filter((a) => a.status === "pending"));
    setInbox(s.inbox.filter((e) => e.sourceAgent !== meta.id));
  }, [meta.id]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/agents/${meta.id}`)
      .then((r) => r.json())
      .then((s: AgentStateResponse) => {
        if (cancelled) return;
        const hist = s.history.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
          toolCalls: m.toolCalls,
        })) as ChatMessage[];
        setMessages(hist.length ? hist : [{ role: "assistant", content: meta.welcome }]);
        applyState(s);
      })
      .catch(() => setMessages([{ role: "assistant", content: meta.welcome }]));
    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.welcome, applyState]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string, via: "text" | "voice" = "text") => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput("");
      setMessages((m) => [...m, { role: "user", content: trimmed }]);
      setBusy(true);
      try {
        const res = await fetch(`/api/agents/${meta.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, via }),
        });
        const data = await res.json();
        const replyText: string = data.reply?.text ?? "Sorry, something went wrong.";
        setMessages((m) => [...m, { role: "assistant", content: replyText, toolCalls: data.reply?.toolCalls }]);
        applyState(data);
        if (voiceEnabled) void speak(replyText);
      } catch {
        setMessages((m) => [...m, { role: "assistant", content: "I couldn't reach the server just now. Please try again." }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, meta.id, applyState, voiceEnabled],
  );

  const toggleMic = useCallback(() => {
    if (listening) return;
    const rec = createRecognizer({
      onResult: (t) => void send(t, "voice"),
      onEnd: () => setListening(false),
      onError: () => setListening(false),
    });
    if (!rec) {
      alert("Voice input isn't supported in this browser. Please type instead.");
      return;
    }
    setListening(true);
    rec.start();
  }, [listening, send]);

  const decide = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      const res = await fetch(`/api/agents/${meta.id}/approvals/${approvalId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      applyState(data);
      if (decision === "approve" && data.record?.summary) {
        setMessages((m) => [...m, { role: "assistant", content: data.record.summary }]);
      }
    },
    [meta.id, applyState],
  );

  const activeTasks = tasks.filter((t) => !["completed", "cancelled", "failed"].includes(t.status));

  return (
    <div className="flex min-h-[100dvh] flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 px-4 pb-3 pt-4 text-white" style={{ background: meta.theme.gradient }}>
        <div className="flex items-center gap-3">
          <Link href="/agents" className="btn rounded-full bg-white/20 px-3 py-1 text-sm">
            ‹ Back
          </Link>
          <div className="flex items-center gap-2">
            <Icon width={22} height={22} />
            <span className="text-[18px] font-bold">{meta.displayName}</span>
          </div>
          <button
            onClick={() => setVoiceEnabled((v) => !v)}
            className="btn ml-auto rounded-full bg-white/20 px-3 py-1 text-xs"
            aria-pressed={voiceEnabled}
          >
            {voiceEnabled ? "🔊 Voice on" : "🔈 Voice off"}
          </button>
        </div>
        <p className="mt-1 text-[13px] text-white/85">{meta.tagline}</p>
      </header>

      {/* Status cards */}
      {(approvals.length > 0 || activeTasks.length > 0 || inbox.length > 0) && (
        <div className="flex gap-2 overflow-x-auto scroll-hide px-4 py-3">
          {approvals.map((a) => (
            <div key={a.id} className="card fade-up w-[270px] shrink-0 p-3" style={{ borderColor: "#fca5a5" }}>
              <div className="text-[11px] font-bold uppercase text-red-600">Needs your approval</div>
              <div className="mt-0.5 text-[14px] font-semibold">{a.title}</div>
              <div className="text-[12px] text-[var(--muted)]">{a.description}</div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => decide(a.id, "approve")} className="btn flex flex-1 items-center justify-center gap-1 bg-emerald-600 py-1.5 text-sm font-semibold text-white">
                  <CheckIcon width={16} height={16} /> Approve
                </button>
                <button onClick={() => decide(a.id, "reject")} className="btn flex flex-1 items-center justify-center gap-1 bg-gray-200 py-1.5 text-sm font-semibold">
                  <XIcon width={16} height={16} /> No
                </button>
              </div>
            </div>
          ))}
          {activeTasks.map((t) => (
            <div key={t.id} className="card w-[240px] shrink-0 p-3">
              <div className="text-[11px] font-bold uppercase" style={{ color: meta.theme.accent }}>
                Active task · {t.status.replace("_", " ")}
              </div>
              <div className="mt-0.5 text-[14px] font-semibold leading-snug">{t.title}</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {t.steps.map((s) => (
                  <span
                    key={s.id}
                    className="pill px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      background: s.status === "done" ? meta.theme.accentSoft : "#f1f3f8",
                      color: s.status === "done" ? meta.theme.accent : "#8a93a6",
                    }}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {inbox.map((e) => (
            <div key={e.id} className="card w-[240px] shrink-0 p-3" style={{ borderColor: meta.theme.accentSoft }}>
              <div className="text-[11px] font-bold uppercase" style={{ color: meta.theme.accent }}>
                From {e.sourceAgent} · {e.status}
              </div>
              <div className="mt-0.5 text-[13px] leading-snug">{e.type}</div>
            </div>
          ))}
        </div>
      )}

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-hide px-4 pb-4">
        <div className="flex flex-col gap-3 pt-2">
          {messages.map((m, i) => (
            <div key={i} className={`fade-up flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className="max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed"
                style={
                  m.role === "user"
                    ? { background: meta.theme.accent, color: "#fff", borderBottomRightRadius: 6 }
                    : { background: "#fff", border: "1px solid var(--line)", borderBottomLeftRadius: 6 }
                }
              >
                {m.content}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1 border-t border-black/5 pt-2">
                    {m.toolCalls.map((c) => (
                      <div key={c.id} className="text-[11px]" style={{ color: m.role === "user" ? "rgba(255,255,255,.85)" : "#8a93a6" }}>
                        {c.status === "success" ? "✓" : c.status === "awaiting_approval" ? "⏳" : "⚠"} {c.toolName}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-[var(--line)] bg-white px-4 py-2.5 text-[var(--muted)]">…</div>
            </div>
          )}
        </div>

        {/* Suggestions */}
        {messages.length <= 1 && (
          <div className="mt-4 flex flex-col gap-2">
            <div className="text-[12px] font-semibold uppercase text-[var(--muted)]">Try saying</div>
            {meta.suggestedCommands.map((c) => (
              <button key={c} onClick={() => send(c)} className="btn card px-3 py-2 text-left text-[14px]">
                “{c}”
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="sticky bottom-[72px] z-30 border-t border-[var(--line)] bg-white/95 px-3 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMic}
            className={`btn flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white ${listening ? "mic-live" : ""}`}
            style={{ background: listening ? "#ef4444" : meta.theme.accent }}
            aria-label="Hold to speak"
          >
            <MicIcon width={22} height={22} />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder={listening ? "Listening…" : speechRecognitionSupported() ? "Tap mic or type…" : "Type a message…"}
            className="h-12 flex-1 rounded-full border border-[var(--line)] bg-[var(--bg)] px-4 text-[15px] outline-none"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || busy}
            className="btn flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40"
            style={{ background: meta.theme.accent }}
            aria-label="Send"
          >
            <SendIcon width={20} height={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
