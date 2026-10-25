"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import { BrandLogo } from "@/components/BrandLogo";

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
  provenance: { provider: string; model: string; mode: string };
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
interface ContinuityItem { id: string; kind: string; text: string; createdAt: number }
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

const DIRECTION_LABEL: Record<string, string> = {
  improving: "↑ improving", declining: "↓ getting harder", stable: "→ steady", insufficient_data: "not enough data yet",
};

function fmtDate(ts: number): string {
  try { return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return ""; }
}
function fmtTime(ts: number): string {
  try { return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

/** A gentle inline sparkline for a trend. */
function Sparkline({ points }: { points: { value: number }[] }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const w = 120, h = 36;
  const step = w / (vals.length - 1);
  const d = vals.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - ((v - min) / span) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function WellnessDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

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

      {/* Trends */}
      <h2 className="eyebrow mt-7">Sleep &amp; energy trends</h2>
      <div className="mt-2 grid grid-cols-1 gap-2.5">
        {[data.sleepTrend, data.energyTrend].map((t) => (
          <div key={t.metric} className="card flex items-center justify-between gap-3 p-4">
            <div>
              <div className="text-[15px] font-bold capitalize">{t.metric}</div>
              <div className="text-[13px] text-[var(--muted)]">
                {t.count} reading(s) · {DIRECTION_LABEL[t.direction] ?? t.direction}
                {t.metric === "sleep" && t.average !== null ? ` · avg ${t.average}h` : ""}
              </div>
            </div>
            <Sparkline points={t.points} />
          </div>
        ))}
      </div>

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
              <span>via {o.provenance.provider}/{o.provenance.model} ({o.provenance.mode})</span>
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
              <div key={c.id} className="card p-3 text-[14px]"><span className="text-[var(--faint)]">{c.kind}:</span> {c.text}</div>
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
