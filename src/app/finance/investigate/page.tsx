"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import type { Investigation, InvestigationStep } from "@/agents/finance/investigation/service";
import { CheckIcon, ChevronLeftIcon, ReceiptIcon, XIcon } from "@/components/icons";
import { speak } from "@/lib/speech";

interface Snapshot {
  documents: { documentId: string; kind: string; title: string; text: string }[];
  latest: Investigation | null;
  history: { id: string; title: string; status: string; engine: string; createdAt: number }[];
  approval: null | { id: string; title: string; description: string };
  approvalStatus: string | null;
  integrations: IntegrationStatus[];
}

const ACCENT = "#3b449c";
const ACCENT_BG = "linear-gradient(135deg,#4a59bc,#5a6acf)";

function money(n: number | undefined) {
  return `$${(n ?? 0).toFixed(2)}`;
}

const STEP_STYLE: Record<InvestigationStep["kind"], { icon: string; tone: string }> = {
  queued: { icon: "⏳", tone: "#6b7785" },
  status: { icon: "⚙️", tone: "#3d4a56" },
  scope: { icon: "🔒", tone: "#065f46" },
  session: { icon: "🤖", tone: "#3b449c" },
  progress: { icon: "➜", tone: "#3b449c" },
  tool_call: { icon: "🧮", tone: "#3d4a56" },
  tool_result: { icon: "✓", tone: "#065f46" },
  assistant: { icon: "💬", tone: "#3d4a56" },
  permission: { icon: "⛔", tone: "#b91c1c" },
  error: { icon: "⚠️", tone: "#b91c1c" },
  verify: { icon: "🔎", tone: "#065f46" },
  finance: { icon: "💼", tone: "#3b449c" },
};

function Step({ s, startedAt }: { s: InvestigationStep; startedAt: number }) {
  const st = STEP_STYLE[s.kind];
  const technical = s.kind === "tool_call" || s.kind === "tool_result" || s.kind === "session" || s.kind === "scope";
  return (
    <li className="flex gap-3 py-2">
      <span aria-hidden className="mt-0.5 w-6 shrink-0 text-center text-[17px]" style={{ color: s.ok === false ? "#b91c1c" : st.tone }}>
        {s.ok === false && s.kind === "tool_result" ? "✗" : st.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`leading-snug ${s.kind === "progress" || s.kind === "finance" || s.kind === "verify" ? "text-[17px] font-bold" : "text-[16px] font-semibold"}`}>{s.label}</span>
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-[var(--faint)]">+{((s.at - startedAt) / 1000).toFixed(1)}s</span>
        </div>
        {s.detail && (
          <p className={`mt-0.5 break-words leading-snug text-[var(--muted)] ${technical ? "font-mono text-[12.5px]" : "text-[15px]"}`}>{s.detail}</p>
        )}
      </div>
    </li>
  );
}

export default function InvestigatePage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = (await (await fetch("/api/finance/investigations", { cache: "no-store" })).json()) as Snapshot;
      setSnap(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inv = snap?.latest ?? null;
  const active = inv?.status === "pending" || inv?.status === "running";

  // Poll while the worker is running so progress appears live.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 1200);
    return () => clearInterval(t);
  }, [active, refresh]);

  const start = useCallback(async () => {
    if (busy) return;
    setBusy("start");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/finance/investigations", { method: "POST" });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Couldn't start the investigation.");
      else setSnap(data as Snapshot);
    } catch {
      setError("Couldn't reach Finance. Please try again.");
    } finally {
      setBusy(null);
    }
  }, [busy]);

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      if (!snap?.approval || busy) return;
      setBusy(decision);
      try {
        const res = await fetch(`/api/agents/finance/approvals/${snap.approval.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const data = await res.json();
        setNotice(decision === "approve" ? (data?.record?.summary ?? "Dispute submitted.") : "Okay. The dispute is saved as a draft and was not sent.");
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [snap, busy, refresh],
  );

  const bill = snap?.documents.find((d) => d.kind === "itemized_bill");
  const droid = snap?.integrations.find((i) => i.key === "factory-droid");
  const report = inv?.report;
  const v = inv?.verification;
  const startedAt = inv?.steps[0]?.at ?? 0;

  return (
    <main className="pb-36 text-[17px]">
      <header className="sticky top-0 z-30 rounded-b-[26px] px-4 pb-5 pt-4 text-white shadow-lg" style={{ background: ACCENT_BG }}>
        <div className="flex items-center gap-3">
          <Link
            href="/agents/finance"
            className="btn flex h-11 w-11 items-center justify-center rounded-full bg-white/25 ring-1 ring-inset ring-white/30"
            aria-label="Back to Finance"
          >
            <ChevronLeftIcon width={22} height={22} />
          </Link>
          <h1 className="text-[24px] font-extrabold tracking-tight">Bill investigation</h1>
        </div>
        <p className="mt-2 text-[15px] leading-snug text-white/90">
          Finance hands the bill to a separate investigation agent, then checks its work before telling you anything.
        </p>
      </header>

      {/* The bill */}
      <section className="px-4" aria-labelledby="bill-h">
        <div className="card mt-4 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl" style={{ background: "#eceefb", color: ACCENT }}>
              <ReceiptIcon width={24} height={24} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="bill-h" className="text-[19px] font-extrabold leading-snug">
                {bill?.title ?? "Loading bill…"}
              </h2>
              <p className="text-[15px] text-[var(--muted)]">Emergency visit, Sept 12. Insurance EOB attached.</p>
            </div>
          </div>
          <button
            onClick={() => void start()}
            disabled={!!busy || active || !snap}
            className="btn mt-4 flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl text-[20px] font-extrabold text-white shadow-md disabled:opacity-50"
            style={{ background: ACCENT_BG }}
          >
            🔎 {active ? "Investigating…" : busy === "start" ? "Starting…" : inv ? "Investigate again" : "Investigate this bill"}
          </button>
          {error && <p className="mt-2 rounded-xl bg-red-50 p-3 text-[15px] text-red-800">{error}</p>}
          <details className="mt-3">
            <summary className="cursor-pointer text-[15px] font-semibold" style={{ color: ACCENT }}>
              See the documents the investigator may read ({snap?.documents.length ?? 0})
            </summary>
            {snap?.documents.map((d) => (
              <pre key={d.documentId} className="mt-2 overflow-x-auto rounded-xl bg-[var(--bg-tint)] p-3 text-[11.5px] leading-snug">
                {d.text}
              </pre>
            ))}
          </details>
        </div>
      </section>

      {/* Live progress */}
      {inv && (
        <section className="px-4" aria-labelledby="prog-h">
          <div className="card mt-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="prog-h" className="text-[20px] font-extrabold">
                {active ? "Working on it" : inv.status === "failed" ? "Investigation stopped" : "What happened"}
              </h2>
              <span
                className="pill px-2.5 py-0.5 text-[13px] font-bold"
                style={inv.engine === "factory-droid" ? { background: "#eceefb", color: ACCENT } : { background: "#fef3c7", color: "#7c4a03" }}
              >
                {inv.engine === "factory-droid" ? "Factory Droid" : "Local engine (no Droid)"}
              </span>
              {active && <span className="live-dot ml-auto" style={{ background: ACCENT }} aria-label="running" />}
            </div>
            <ol className="mt-2 divide-y divide-[var(--line)]" aria-live="polite">
              {inv.steps.map((s) => (
                <Step key={s.id} s={s} startedAt={startedAt} />
              ))}
            </ol>
            {(inv.droidSessionId || inv.durationMs || inv.tokenUsage) && (
              <p className="mt-2 border-t border-[var(--line)] pt-2 font-mono text-[12px] text-[var(--faint)]">
                {inv.droidSessionId ? `session ${inv.droidSessionId} · ` : ""}
                {inv.durationMs ? `${(inv.durationMs / 1000).toFixed(1)}s` : ""}
                {inv.tokenUsage ? ` · ${inv.tokenUsage.inputTokens} in / ${inv.tokenUsage.outputTokens} out tokens` : ""}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Finance's verified findings */}
      {inv?.status === "completed" && report && v && (
        <section className="px-4" aria-labelledby="res-h">
          <div className="card mt-4 p-4">
            <div className="flex items-center gap-2">
              <h2 id="res-h" className="text-[22px] font-extrabold">
                What Finance found
              </h2>
              <button
                onClick={() => void speak(inv.financeSummary ?? report.summary)}
                className="btn ml-auto min-h-11 rounded-full px-4 text-[15px] font-semibold"
                style={{ background: "#eceefb", color: ACCENT }}
              >
                🔊 Read aloud
              </button>
            </div>
            <p className="mt-2 text-[18px] leading-relaxed">{inv.financeSummary}</p>

            <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl bg-[var(--bg-tint)] p-2.5">
                <dt className="text-[13px] font-semibold text-[var(--muted)]">Bill asks for</dt>
                <dd className="text-[20px] font-extrabold tabular-nums">{money(report.amountDueOnStatement)}</dd>
              </div>
              <div className="rounded-2xl bg-emerald-50 p-2.5">
                <dt className="text-[13px] font-semibold text-emerald-800">Insurance says you owe</dt>
                <dd className="text-[20px] font-extrabold tabular-nums text-emerald-800">{money(report.patientResponsibilityPerInsurer)}</dd>
              </div>
              <div className="rounded-2xl bg-red-50 p-2.5">
                <dt className="text-[13px] font-semibold text-red-800">Not yours to pay</dt>
                <dd className="text-[20px] font-extrabold tabular-nums text-red-800">{money(v.verifiedOvercharge)}</dd>
              </div>
            </dl>

            <h3 className="mt-5 text-[18px] font-extrabold">Problems on the bill</h3>
            <ul className="mt-1 space-y-3">
              {report.findings.map((f, i) => (
                <li key={i} className="rounded-2xl border border-[var(--line)] p-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[17px] font-bold leading-snug">{f.title}</span>
                    <span className="ml-auto text-[17px] font-bold tabular-nums">{money(f.amount)}</span>
                  </div>
                  <p className="mt-1 text-[15px] leading-snug">{f.evidence}</p>
                  {f.calculation && <p className="mt-1 font-mono text-[12.5px] text-[var(--muted)]">{f.calculation}</p>}
                </li>
              ))}
            </ul>

            <h3 className="mt-5 text-[16px] font-extrabold">Finance's double-check</h3>
            <ul className="mt-1 space-y-1">
              {v.checks.map((c) => (
                <li key={c.label} className="flex items-center gap-2 text-[15px]">
                  {c.ok ? <CheckIcon width={18} height={18} className="text-emerald-700" /> : <XIcon width={18} height={18} className="text-red-700" />}
                  <span>{c.label}</span>
                  <span className="ml-auto tabular-nums">{money(c.recomputed)}</span>
                </li>
              ))}
            </ul>
            {v.notes.length > 0 && <p className="mt-2 rounded-xl bg-amber-50 p-3 text-[15px] text-amber-900">{v.notes.join(" ")}</p>}
          </div>

          {snap?.approval ? (
            <div className="card mt-4 p-4" style={{ borderColor: "#c7cdf3" }}>
              <h3 className="text-[19px] font-extrabold">{snap.approval.title}</h3>
              <p id="dispute-desc" className="mt-1 text-[16px] leading-snug text-[var(--muted)]">
                Nothing is sent unless you approve. {snap.approval.description}
              </p>
              <button
                onClick={() => void decide("approve")}
                disabled={!!busy}
                aria-describedby="dispute-desc"
                className="btn mt-3 flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-700 text-[19px] font-extrabold text-white shadow-md disabled:opacity-50"
              >
                <CheckIcon width={24} height={24} />
                {busy === "approve" ? "Sending…" : `Approve: dispute ${money(v.verifiedOvercharge)}`}
              </button>
              <button
                onClick={() => void decide("reject")}
                disabled={!!busy}
                className="btn mt-2 min-h-12 w-full rounded-2xl bg-[var(--bg-tint)] text-[17px] font-semibold text-[var(--ink)] disabled:opacity-50"
              >
                Not now
              </button>
            </div>
          ) : (
            snap?.approvalStatus && (
              <p className="card mt-4 p-4 text-[16px]">
                {notice ?? (snap.approvalStatus === "approved" ? "You approved the dispute. It was submitted and logged for review." : "The dispute was not sent.")}
              </p>
            )
          )}
        </section>
      )}

      {/* Honest integration labels */}
      {snap && (
        <section className="px-4 pt-5" aria-label="How this works">
          <ul className="space-y-1.5 text-[14px] leading-snug text-[var(--muted)]">
            {snap.integrations.map((i) => (
              <li key={i.key}>
                <span className="font-semibold text-[var(--ink)]">{i.label}</span>: {i.detail}
              </li>
            ))}
          </ul>
          {droid?.mode !== "live" && <p className="mt-1 text-[13px] text-[var(--faint)]">Set FACTORY_API_KEY to run investigations on Factory Droid.</p>}
        </section>
      )}
    </main>
  );
}
