"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import { BrandLogo } from "@/components/BrandLogo";
import { WellnessTrendsCard } from "@/components/WellnessTrendsCard";

/** ---- Types mirrored from the dashboard API ---- */
interface Observation {
  id: string;
  recordId: string;
  type: string;
  value?: number;
  unit?: string;
  description?: string;
  requiresConfirmation: boolean;
  evidence: string;
  provenance: { provider: string; model: string; mode: string; requestId?: string };
  createdAt: number;
  correctedAt?: number;
}
interface Trend {
  metric: string;
  count: number;
  average: number | null;
  latest: number | null;
  direction: string;
  points: { value: number; at: number }[];
}
interface ContinuityItem { id: string; kind: string; text: string; createdAt: number; sync: string; reason?: string }
interface ContextItem { recordId: string; category: string; topic: string; fact: string; sourceAt: number; correctedAt?: number; syncState: string }
interface Aggregate { metric: string; value: number; observationCount: number }
interface AuditEntry { actor: string; action: string; at: number; detail?: Record<string, unknown> }
interface Dashboard {
  user: { name: string; role: string };
  observations: Observation[];
  continuity: ContinuityItem[];
  conversationContext: ContextItem[];
  sleepTrend: Trend;
  energyTrend: Trend;
  report: { period: string; headline: string; lines: string[] };
  analytics: Aggregate[];
  consent: Record<string, boolean>;
  integrations: IntegrationStatus[];
  audit: AuditEntry[];
  backends: { timeseries: string; personalMemory: string };
}
/** Response of /api/wellness/extract: one verifiable Bitdeer inference. */
interface ExtractRun {
  ok: boolean;
  summary: string;
  error?: string;
  result?: {
    sentText: string;
    inferenceError?: string;
    trace?: { requestId: string; endpoint: string; latencyMs: number; finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number }; rawContent: string };
    provenance: { provider: string; model: string; mode: string; redactions: number; externalSkipped: boolean };
    accepted: Observation[];
    needsConfirmation: Observation[];
    rejected: { type?: string; reason: string; layer: string }[];
    savedIds: string[];
  };
}

const ACCENT = "#c98a2e";
const ACCENT_SOFT = "#fbf0dc";

const MODE_STYLE: Record<string, { bg: string; color: string }> = {
  live: { bg: "#d1fae5", color: "#065f46" },
  sandbox: { bg: "#fef3c7", color: "#92400e" },
  unavailable: { bg: "#fee2e2", color: "#991b1b" },
};

const TYPE_LABEL: Record<string, string> = {
  sleep_duration: "Sleep", sleep_quality: "Sleep quality", energy: "Energy",
  mood: "Mood", appetite: "Appetite", pain: "Pain", social: "Social", activity: "Activity", other: "Note",
};

function fmtDate(ts: number): string {
  try { return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; }
}
function fmtTime(ts: number): string {
  try { return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

export default function WellnessDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [tryText, setTryText] = useState("I haven't been sleeping well lately. I only slept four hours last night.");
  const [tryBusy, setTryBusy] = useState(false);
  const [run, setRun] = useState<ExtractRun | null>(null);

  const load = useCallback(() => {
    fetch("/api/wellness/dashboard").then((r) => r.json()).then(setData).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch("/api/wellness/observation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      load();
    } finally {
      setBusy(false);
      setEditing(null);
    }
  }, [load]);

  const runInference = useCallback(async () => {
    setTryBusy(true);
    try {
      const r = await fetch("/api/wellness/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: tryText }) });
      setRun(await r.json());
      load();
    } finally {
      setTryBusy(false);
    }
  }, [tryText, load]);

  const setConsent = useCallback(async (key: string, val: boolean) => {
    setData((d) => (d ? { ...d, consent: { ...d.consent, [key]: val } } : d));
    await fetch("/api/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: val }) });
    load();
  }, [load]);

  if (!data) {
    return <main className="px-5 pt-8"><h1 className="text-[26px] font-extrabold tracking-tight">Wellness</h1><p className="mt-3 text-[var(--muted)]">Loading your workspace…</p></main>;
  }

  const consentToggles: { key: string; label: string; help: string }[] = [
    { key: "wellnessExternalProcessing", label: "External AI extraction", help: "Allow minimized text to be processed by the Bitdeer model. Off = on-device only." },
    { key: "wellnessMemory", label: "Personal & historical memory", help: "Let Wellness remember continuity and recall past conversations (Moss / Backboard)." },
    { key: "wellnessConversationMemory", label: "Remember our conversations", help: "Let Wellness remember hobbies and family visits you mention, so it can ask about them later (Backboard). Off = nothing new is saved and nothing is recalled." },
    { key: "wellnessTimeSeriesSync", label: "Sleep & energy trends", help: "Mirror only the numbers (sleep hours, energy rating) to Tiger Data for weekly trends. Off = the mirror is deleted; your saved notes stay." },
    { key: "wellnessHouseholdAnalytics", label: "Household analytics", help: "Share de-identified aggregates (averages, counts) with authorized family. Never raw conversations." },
    { key: "caregiverWellnessRaw", label: "Caregivers see raw conversations", help: "Off by default. When off, family see only aggregates and authorized updates." },
  ];

  return (
    <main className="px-4 pt-7 pb-4">
      {/* Header */}
      <header className="relative overflow-hidden rounded-[24px] p-5 text-white" style={{ background: "linear-gradient(135deg,#b3761e,#c98a2e)", boxShadow: "var(--shadow-lg)" }}>
        <div aria-hidden className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-white/15 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/20 text-[22px] backdrop-blur">✨</span>
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight">Wellness</h1>
            <div className="text-[13px] text-white/85">Hello {data.user.name}. Here's everything in one place.</div>
          </div>
        </div>
        <Link href="/agents/wellness" className="btn relative mt-4 inline-flex items-center gap-2 rounded-full bg-white/20 px-4 py-2 text-[14px] font-semibold backdrop-blur transition-colors hover:bg-white/30">
          💬 Start a conversation
        </Link>
      </header>

      {/* Bitdeer inference: one live, verifiable model request */}
      <h2 className="eyebrow mt-7">Model inference · Bitdeer AI</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">Send one message through the model. Its proposals are checked in code against your words before anything is saved.</p>
      <section className="card mt-2 p-3.5">
        <textarea
          value={tryText} onChange={(e) => setTryText(e.target.value)} rows={2} aria-label="Message to analyze"
          className="w-full rounded-xl border border-[var(--line)] bg-transparent p-2.5 text-[14px]"
        />
        <button onClick={runInference} disabled={tryBusy || !tryText.trim()} className="btn mt-2 rounded-full px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-60" style={{ background: ACCENT }}>
          {tryBusy ? "Asking the model…" : "Run inference"}
        </button>
        {run && (
          <div className="mt-3 flex flex-col gap-2 text-[12px]">
            {run.result?.inferenceError || !run.result ? (
              <div className="rounded-xl bg-red-50 p-2.5 text-red-800">Model call failed, nothing stored: {run.result?.inferenceError ?? run.error ?? run.summary}</div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="pill px-2 py-0.5 font-semibold" style={MODE_STYLE[run.result.provenance.mode] ?? MODE_STYLE.sandbox}>{run.result.provenance.mode}</span>
                  <span className="font-semibold">{run.result.provenance.provider}/{run.result.provenance.model}</span>
                  {run.result.trace && <span className="text-[var(--faint)]">· {run.result.trace.latencyMs} ms · tokens {run.result.trace.usage?.promptTokens ?? "-"}/{run.result.trace.usage?.completionTokens ?? "-"}</span>}
                </div>
                {run.result.trace && <div className="text-[var(--muted)]">POST {run.result.trace.endpoint}<br />response id <code>{run.result.trace.requestId}</code></div>}
                <div><span className="font-semibold">Sent ({run.result.provenance.redactions} redaction(s)):</span> “{run.result.sentText}”</div>
                {run.result.trace && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-black/5 p-2.5 text-[11px]">{run.result.trace.rawContent}</pre>}
                {run.result.accepted.map((o, i) => (
                  <div key={`a${i}`}>✓ <b>{TYPE_LABEL[o.type] ?? o.type}</b> {o.value !== undefined ? `${o.value} ${o.unit ?? ""}` : o.description} <span className="italic text-[var(--muted)]">evidence: “{o.evidence}”</span></div>
                ))}
                {run.result.needsConfirmation.map((o, i) => (
                  <div key={`c${i}`}>? <b>{TYPE_LABEL[o.type] ?? o.type}</b> {o.description ?? o.value} <span className="text-[var(--muted)]">(needs confirmation, not stored)</span></div>
                ))}
                {run.result.rejected.map((r, i) => (
                  <div key={`r${i}`} className="text-red-800">✗ {r.type ?? "?"} ({r.layer}): {r.reason}</div>
                ))}
                <div className="text-[var(--faint)]">{run.result.savedIds.length} observation(s) stored with this request id as provenance.</div>
              </>
            )}
          </div>
        )}
      </section>

      {/* Trends */}
      <h2 className="eyebrow mt-7">Sleep &amp; energy trends</h2>
      <WellnessTrendsCard
        audience="self"
        onChange={load}
        refreshToken={`${data.consent.wellnessTimeSeriesSync}|${data.observations.map((o) => `${o.recordId}:${o.value ?? ""}`).join(",")}`}
      />

      {/* Recent observations with review/correct/delete */}
      <h2 className="eyebrow mt-7">What I've noticed</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">You can correct or delete anything here. Your words always win.</p>
      <section className="mt-2 flex flex-col gap-2.5">
        {data.observations.length === 0 && <div className="card p-4 text-[14px] text-[var(--muted)]">Nothing remembered yet. Start a conversation and I'll gently keep track.</div>}
        {data.observations.map((o) => (
          <div key={o.recordId} className="card p-3.5">
            <div className="flex items-center gap-2">
              <span className="pill px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide" style={{ background: ACCENT_SOFT, color: ACCENT }}>{TYPE_LABEL[o.type] ?? o.type}</span>
              <span className="text-[15px] font-semibold">
                {o.value !== undefined ? `${o.value} ${o.unit ?? ""}`.trim() : o.description}
              </span>
              <span className="ml-auto text-[12px] text-[var(--faint)]">{fmtDate(o.createdAt)}</span>
            </div>
            {o.evidence && <div className="mt-1.5 text-[12px] italic leading-snug text-[var(--muted)]">“{o.evidence}”</div>}
            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <span>via {o.provenance.provider}/{o.provenance.model} ({o.provenance.mode}){o.provenance.requestId ? ` · req ${o.provenance.requestId.slice(0, 10)}` : ""}</span>
              {o.requiresConfirmation && <span className="pill bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">needs confirmation</span>}
              {o.correctedAt && <span className="pill bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">corrected</span>}
            </div>
            {editing === o.recordId ? (
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
                  aria-label={o.value !== undefined ? "Correct the value in hours" : "Correct the description"}
                  placeholder={o.value !== undefined ? "Correct value (hours)" : "Correct description"}
                  className="h-10 flex-1 rounded-xl border border-[var(--line)] px-3 text-[14px] outline-none"
                />
                <button
                  disabled={busy} onClick={() => act(o.value !== undefined ? { action: "correct", recordId: o.recordId, value: Number(editText), unit: o.unit ?? "hours" } : { action: "correct", recordId: o.recordId, description: editText })}
                  className="btn rounded-xl px-3 py-2 text-[13px] font-semibold text-white" style={{ background: ACCENT }}
                >Save</button>
                <button onClick={() => setEditing(null)} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-2 text-[13px] font-semibold text-[var(--muted)]">Cancel</button>
              </div>
            ) : (
              <div className="mt-2.5 flex gap-2">
                <button onClick={() => { setEditing(o.recordId); setEditText(o.value !== undefined ? String(o.value) : o.description ?? ""); }} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ink)]">Correct</button>
                <button disabled={busy} onClick={() => act({ action: "forget", recordId: o.recordId })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold text-red-600">Forget</button>
              </div>
            )}
          </div>
        ))}
      </section>

      {/* Conversational context (Convex canonical, indexed in Backboard) */}
      <h2 className="eyebrow mt-7">What you've told me</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">Hobbies and visits I remember so I can ask about them later. Correct or forget anything.</p>
      <section className="mt-2 flex flex-col gap-2.5">
        {data.conversationContext.length === 0 && <div className="card p-4 text-[14px] text-[var(--muted)]">Nothing yet. Tell me about your hobbies or who's coming to visit.</div>}
        {data.conversationContext.map((c) => (
          <div key={c.recordId} className="card p-3.5">
            <div className="flex items-center gap-2">
              <span className="pill px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide" style={{ background: ACCENT_SOFT, color: ACCENT }}>{c.category === "family_visit" ? "Family" : "Hobby"}</span>
              <span className="text-[15px] font-semibold capitalize">{c.topic}</span>
              <span className="ml-auto text-[12px] text-[var(--faint)]">{fmtDate(c.sourceAt)}</span>
            </div>
            <div className="mt-1.5 text-[14px] leading-snug">“{c.fact}”</div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <span>Backboard: {c.syncState === "synced" ? "in sync" : c.syncState === "pending" ? "update pending (old copy is never used)" : "not indexed"}</span>
              {c.correctedAt && <span className="pill bg-blue-100 px-2 py-0.5 font-semibold text-blue-800">corrected</span>}
            </div>
            {editing === c.recordId ? (
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  autoFocus value={editText} onChange={(e) => setEditText(e.target.value)}
                  aria-label="Correct what I remember" placeholder="What should I remember?"
                  className="h-10 flex-1 rounded-xl border border-[var(--line)] px-3 text-[14px] outline-none"
                />
                <button disabled={busy || !editText.trim()} onClick={() => act({ action: "correctContext", recordId: c.recordId, fact: editText })} className="btn rounded-xl px-3 py-2 text-[13px] font-semibold text-white" style={{ background: ACCENT }}>Save</button>
                <button onClick={() => setEditing(null)} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-2 text-[13px] font-semibold text-[var(--muted)]">Cancel</button>
              </div>
            ) : (
              <div className="mt-2.5 flex gap-2">
                <button onClick={() => { setEditing(c.recordId); setEditText(c.fact); }} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ink)]">Correct</button>
                <button disabled={busy} onClick={() => act({ action: "forgetContext", recordId: c.recordId })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold text-red-600">Forget</button>
              </div>
            )}
          </div>
        ))}
      </section>

      {/* Personal memory (Moss) */}
      {data.continuity.length > 0 && (
        <>
          <h2 className="eyebrow mt-7">Personal memory <span className="text-[var(--faint)] normal-case">· {data.backends.personalMemory}</span></h2>
          <section className="mt-2 flex flex-col gap-2">
            {data.continuity.map((c) => (
              <div key={c.id} className="card p-3 text-[14px]">
                <span className="text-[var(--faint)]">{c.kind}:</span> {c.text}
                <div className="mt-1 text-[12px] text-[var(--faint)]">
                  {c.sync === "synced" ? "Synced to Moss" : c.sync === "failed" ? "Moss sync failed, kept in Convex" : `Kept private in Convex${c.reason ? ` (${c.reason})` : ""}`}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {/* Monthly household report */}
      <h2 className="eyebrow mt-7">Monthly household report</h2>
      <div className="card mt-2 p-4">
        <div className="text-[15px] font-bold">{data.report.headline}</div>
        <div className="text-[12px] text-[var(--faint)]">{data.report.period}</div>
        <ul className="mt-2 flex flex-col gap-1">
          {data.report.lines.map((l, i) => <li key={i} className="text-[14px] text-[var(--muted)]">• {l}</li>)}
        </ul>
      </div>

      {/* Consent & privacy */}
      <h2 className="eyebrow mt-7">Consent &amp; privacy</h2>
      <section className="mt-2 flex flex-col gap-2.5">
        {consentToggles.map((t) => (
          <label key={t.key} className="card flex cursor-pointer items-start gap-3 p-3.5">
            <input type="checkbox" checked={!!data.consent[t.key]} onChange={(e) => setConsent(t.key, e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--brand)]" style={{ accentColor: ACCENT }} />
            <div>
              <div className="text-[15px] font-semibold">{t.label}</div>
              <div className="text-[12px] leading-snug text-[var(--muted)]">{t.help}</div>
            </div>
          </label>
        ))}
      </section>

      {/* Integration status */}
      <h2 className="eyebrow mt-7">Integration status</h2>
      <section className="mt-2 flex flex-col gap-2">
        {data.integrations.map((i) => {
          const s = MODE_STYLE[i.mode];
          return (
            <div key={i.key} className="card p-3">
              <div className="flex items-center gap-2">
                <BrandLogo brandKey={i.key} label={i.label} size={24} />
                <div className="text-[14px] font-bold">{i.label}</div>
                <span className="pill ml-auto px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: s.bg, color: s.color }}>{i.mode}</span>
              </div>
              <div className="mt-0.5 text-[12px] leading-snug text-[var(--muted)]">{i.detail}</div>
            </div>
          );
        })}
      </section>

      {/* Audit timeline */}
      <h2 className="eyebrow mt-7">Audit timeline</h2>
      <section className="mt-2 flex flex-col gap-1.5">
        {data.audit.length === 0 && <div className="card p-3 text-[13px] text-[var(--muted)]">No wellness activity recorded yet.</div>}
        {data.audit.map((e, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-[12px]">
            <span className="font-mono text-[11px] text-[var(--faint)]">{fmtTime(e.at)}</span>
            <span className="font-semibold">{e.action}</span>
          </div>
        ))}
      </section>

      <p className="mt-7 text-center text-[12px] text-[var(--faint)]">Everything Wellness does is logged here. You are always in control.</p>
    </main>
  );
}
