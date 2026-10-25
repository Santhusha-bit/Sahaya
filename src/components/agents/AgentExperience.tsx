"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMeta } from "@/agents/registry";
import type { AgentEvent, AgentTask, Approval, ConversationMessage, ToolCallRecord } from "@/agents/base/types";
import { AGENT_ICONS, CheckIcon, ChevronLeftIcon, MicIcon, SendIcon, XIcon } from "@/components/icons";
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

/** Parse one SSE block ("event: x\ndata: {...}") into { event, data }. */
function parseSSE(block: string): { event: string; data: any } | null {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

/** Replace the most recent assistant message (used to fill in streamed tokens). */
function setLastAssistant(list: ChatMessage[], content: string, toolCalls?: ToolCallRecord[]): ChatMessage[] {
  const copy = [...list];
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role === "assistant") {
      copy[i] = { ...copy[i], content, ...(toolCalls ? { toolCalls } : {}) };
      break;
    }
  }
  return copy;
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
      // Add the user message and an empty assistant bubble to stream into.
      setMessages((m) => [...m, { role: "user", content: trimmed }, { role: "assistant", content: "" }]);
      setBusy(true);
      try {
        const res = await fetch(`/api/agents/${meta.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, via, stream: true }),
        });
        if (!res.ok || !res.body) throw new Error("no stream");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let full = "";
        let finalData: any = null;
        let finished = false;

        while (!finished) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSSE(block);
            if (!ev) continue;
            if (ev.event === "token") {
              full += ev.data.t ?? "";
              setMessages((m) => setLastAssistant(m, full));
            } else if (ev.event === "done") {
              finalData = ev.data;
              finished = true;
            } else if (ev.event === "error") {
              throw new Error(ev.data?.message ?? "stream error");
            }
          }
        }

        const replyText: string = finalData?.reply?.text ?? full ?? "";
        setMessages((m) => setLastAssistant(m, replyText || "Done.", finalData?.reply?.toolCalls));
        if (finalData) applyState(finalData);
        if (voiceEnabled && replyText) void speak(replyText);
      } catch {
        setMessages((m) => setLastAssistant(m, "I couldn't reach the server just now. Please try again."));
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
      <header
        className="sticky top-0 z-30 overflow-hidden rounded-b-[26px] px-4 pb-4 pt-4 text-white shadow-lg"
        style={{ background: meta.theme.gradient }}
      >
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-14 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <Link
            href="/agents"
            className="btn flex h-9 w-9 items-center justify-center rounded-full bg-white/25 ring-1 ring-inset ring-white/25 backdrop-blur transition-colors hover:bg-white/40"
            aria-label="Back"
          >
            <ChevronLeftIcon width={20} height={20} />
          </Link>
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/25 ring-1 ring-inset ring-white/25 backdrop-blur">
              <Icon width={22} height={22} />
            </span>
            <div className="leading-tight">
              <div className="text-[18px] font-extrabold tracking-tight">{meta.displayName}</div>
              <div className="flex items-center gap-1.5 text-[12px] text-white/90">
                <span className="live-dot" style={{ background: "#fff" }} /> online
              </div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {meta.id === "wellness" && (
              <Link
                href="/wellness"
                className="btn rounded-full bg-white/25 ring-1 ring-inset ring-white/25 px-3 py-1.5 text-xs font-semibold backdrop-blur transition-colors hover:bg-white/40"
                aria-label="Open the Wellness dashboard"
              >
                ✨ Dashboard
              </Link>
            )}
            {meta.id === "care" && (
              <Link
                href="/shop"
                className="btn rounded-full bg-white/25 ring-1 ring-inset ring-white/25 px-3 py-1.5 text-xs font-semibold backdrop-blur transition-colors hover:bg-white/40"
                aria-label="Open the accessible grocery cart"
              >
                🛒 Groceries
              </Link>
            )}
            {meta.id === "finance" && (
              <Link
                href="/finance/investigate"
                className="btn rounded-full bg-white/25 ring-1 ring-inset ring-white/25 px-3 py-1.5 text-xs font-semibold backdrop-blur transition-colors hover:bg-white/40"
                aria-label="Open the bill investigation screen"
              >
                🔎 Investigate
              </Link>
            )}
            <button
              onClick={() => setVoiceEnabled((v) => !v)}
              className="btn rounded-full bg-white/25 ring-1 ring-inset ring-white/25 px-3 py-1.5 text-xs font-semibold backdrop-blur transition-colors hover:bg-white/40"
              aria-pressed={voiceEnabled}
            >
              {voiceEnabled ? "🔊 Voice on" : "🔈 Voice off"}
            </button>
          </div>
        </div>
        <p className="relative mt-2.5 text-[13px] leading-snug text-white/90">{meta.tagline}</p>
      </header>

      {/* Status cards */}
      {(approvals.length > 0 || activeTasks.length > 0 || inbox.length > 0) && (
        <div className="flex gap-2.5 overflow-x-auto scroll-hide px-4 py-3">
          {approvals.map((a) => (
            <div key={a.id} className="card fade-up w-[278px] shrink-0 p-3.5" style={{ borderColor: "#fecaca", background: "linear-gradient(180deg,#fff,#fff6f6)" }}>
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-600">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Needs your approval
              </div>
              <div className="mt-1 text-[14px] font-bold leading-snug">{a.title}</div>
              <div className="text-[12px] leading-snug text-[var(--muted)]">{a.description}</div>
              <div className="mt-2.5 flex gap-2">
                <button onClick={() => decide(a.id, "approve")} className="btn flex flex-1 items-center justify-center gap-1 rounded-xl bg-emerald-600 py-2 text-sm font-semibold text-white shadow-sm">
                  <CheckIcon width={16} height={16} /> Approve
                </button>
                <button onClick={() => decide(a.id, "reject")} className="btn flex flex-1 items-center justify-center gap-1 rounded-xl bg-[var(--bg-tint)] py-2 text-sm font-semibold text-[var(--muted)]">
                  <XIcon width={16} height={16} /> No
                </button>
              </div>
            </div>
          ))}
          {activeTasks.map((t) => (
            <div key={t.id} className="card w-[246px] shrink-0 p-3.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide" style={{ color: meta.theme.accentInk }}>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: meta.theme.accent }} />
                {t.status.replace("_", " ")}
              </div>
              <div className="mt-1 text-[14px] font-bold leading-snug">{t.title}</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {t.steps.map((s) => (
                  <span
                    key={s.id}
                    className="pill px-2 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: s.status === "done" ? meta.theme.accentSoft : "#f1f3f8",
                      color: s.status === "done" ? meta.theme.accentInk : "#8a93a6",
                    }}
                  >
                    {s.status === "done" ? "✓ " : ""}{s.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {inbox.map((e) => (
            <div key={e.id} className="card w-[246px] shrink-0 p-3.5" style={{ borderColor: meta.theme.accentSoft }}>
              <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: meta.theme.accentInk }}>
                From {e.sourceAgent} · {e.status}
              </div>
              <div className="mt-1 text-[13px] leading-snug">{e.type}</div>
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
                className="max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed shadow-sm"
                style={
                  m.role === "user"
                    ? { background: meta.theme.gradient, color: "#fff", borderBottomRightRadius: 6, boxShadow: `0 4px 14px ${meta.theme.accent}33` }
                    : { background: "#fff", border: "1px solid var(--line)", borderBottomLeftRadius: 6 }
                }
              >
                {m.content || (m.role === "assistant" ? "…" : "")}
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
        </div>

        {/* Suggestions */}
        {messages.length <= 1 && (
          <div className="mt-5 flex flex-col gap-2">
            <div className="eyebrow mb-0.5">Try saying</div>
            {meta.suggestedCommands.map((c, i) => (
              <button
                key={c}
                onClick={() => send(c)}
                className={`btn card card-interactive fade-up stagger-${Math.min(i + 1, 4)} flex items-center gap-2 px-3.5 py-2.5 text-left text-[14px]`}
              >
                <span className="text-[var(--faint)]">“</span>
                <span className="flex-1">{c}</span>
                <span className="text-[var(--faint)]">”</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="sticky bottom-[92px] z-30 px-3 pb-1 pt-2">
        <div
          className="flex items-center gap-2 rounded-[22px] border border-[var(--line)] bg-white/90 p-1.5 pl-2 shadow-[0_8px_30px_rgba(20,24,41,0.1)] backdrop-blur-xl"
        >
          <button
            onClick={toggleMic}
            className={`btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white ${listening ? "mic-live" : ""}`}
            style={{ background: listening ? "#ef4444" : meta.theme.accent, boxShadow: `0 4px 12px ${meta.theme.accent}44` }}
            aria-label="Hold to speak"
          >
            <MicIcon width={22} height={22} />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send(input)}
            placeholder={listening ? "Listening…" : speechRecognitionSupported() ? "Tap mic or type…" : "Type a message…"}
            className="h-11 flex-1 bg-transparent px-2 text-[15px] outline-none placeholder:text-[var(--faint)]"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || busy}
            className="btn flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-opacity disabled:opacity-30"
            style={{ background: meta.theme.gradient, boxShadow: `0 4px 12px ${meta.theme.accent}44` }}
            aria-label="Send"
          >
            <SendIcon width={20} height={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
