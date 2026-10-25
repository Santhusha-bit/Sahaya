"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import type { ChainEvent, Finding, InvestigationCase } from "@/agents/finance/investigation/types";
import { CheckIcon, ChevronLeftIcon } from "@/components/icons";

interface Snapshot {
  case: InvestigationCase | null;
  approval: null | { id: string; title: string; description: string };
  chain: null | { ok: boolean; length: number; brokenAt?: number; reason?: string };
  integrations: IntegrationStatus[];
}

const ACCENT = "#3b449c";
const ACCENT_BG = "linear-gradient(135deg,#4a59bc,#5a6acf)";
const SOFT = "#eceefb";

const money = (n: number | undefined) => `$${(n ?? 0).toFixed(2)}`;

const STATUS_TEXT: Record<InvestigationCase["status"], string> = {
  awaiting_review: "Waiting for your review",
  no_issues_found: "No problems found",
  submitted: "Sent to the billing office",
  acknowledged: "Billing office received it",
  under_review: "Billing office is reviewing",
  resolved: "Resolved",
  partially_resolved: "Partly fixed: follow-up needed",
  closed_no_action: "Closed without sending",
};

function StepDots({ step }: { step: number }) {
  const labels = ["Upload", "Review", "Approve", "Track"];
  return (
    <ol className="mt-4 grid grid-cols-4 gap-1.5" aria-label={`Step ${step} of 4: ${labels[step - 1]}`}>
      {labels.map((l, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={l} className="flex flex-col items-center gap-1" aria-current={active ? "step" : undefined}>
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-bold"
              style={{
                background: done || active ? "#fff" : "rgba(255,255,255,.25)",
                color: done || active ? ACCENT : "#fff",
                outline: active ? "3px solid #fff" : undefined,
                outlineOffset: 2,
              }}
            >
              {done ? <CheckIcon width={18} height={18} /> : n}
            </span>
            <span className="text-[13px] font-semibold text-white">{l}</span>
          </li>
        );
      })}
    </ol>
  );
}

function SourceBadge({ f }: { f: Finding }) {
  return (
    <span className="pill px-2.5 py-0.5 text-[12px] font-bold" style={{ background: SOFT, color: ACCENT }}>
      {f.source === "rules+claude" ? "Rules + Claude agree" : "Found by rules"}
    </span>
  );
}

function FindingCard({ f, canReview, busy, onReview }: { f: Finding; canReview: boolean; busy: boolean; onReview: (d: "dismiss" | "restore") => void }) {
  const dismissed = f.review === "dismissed";
  return (
    <li className="border-b border-[var(--line)] p-4" style={dismissed ? { background: "#f7f8fa" } : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill px-2.5 py-0.5 text-[12px] font-bold" style={f.severity === "high" ? { background: "#fee2e2", color: "#991b1b" } : { background: "#fef3c7", color: "#7c4a03" }}>
          {f.findingId} · {f.severity === "high" ? "Likely error" : "Worth checking"}
        </span>
        <SourceBadge f={f} />
        {f.review === "confirmed" && (
          <span className="pill px-2.5 py-0.5 text-[12px] font-bold" style={{ background: "#d1fae5", color: "#065f46" }}>
            Confirmed by you
          </span>
        )}
        {dismissed && <span className="pill bg-[var(--bg-tint)] px-2.5 py-0.5 text-[12px] font-bold text-[var(--muted)]">You said: not an error</span>}
      </div>
      <h3 className={`mt-2 text-[19px] font-bold leading-snug ${dismissed ? "text-[var(--muted)] line-through" : ""}`}>{f.title}</h3>
      <p className="mt-1 text-[16px] leading-snug">{f.explanation}</p>
      {f.explainedBy && <p className="mt-1 text-[15px] text-[var(--muted)]">Fully explained by {f.explainedBy}.</p>}

      {f.evidence.length > 0 && (
        <div className="mt-3">
          <div className="text-[14px] font-bold uppercase tracking-wide text-[var(--muted)]">Evidence</div>
          <ul className="mt-1 space-y-1">
            {f.evidence.map((e) => (
              <li key={`${e.doc}-${e.lineId}`} className="rounded-lg bg-[var(--bg-tint)] p-2">
                <div className="text-[12px] font-semibold text-[var(--muted)]">
                  {e.doc === "bill" ? "Hospital statement" : "Insurance EOB"} · line {e.lineId} · doc {e.docSha256.slice(0, 8)}
                </div>
                <code className="block overflow-x-auto whitespace-pre text-[13px] leading-snug">{e.quote}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[15px] font-semibold" style={{ color: ACCENT }}>
          Show the math
        </summary>
        <table className="mt-2 w-full text-[14px]">
          <tbody>
            {f.calculations.map((c) => (
              <tr key={c.label} className="border-t border-[var(--line)] align-top">
                <td className="py-1.5 pr-2">
                  <div className="font-semibold">{c.label}</div>
                  <div className="text-[13px] text-[var(--muted)]">{c.expression}</div>
                </td>
                <td className="py-1.5 text-right font-bold tabular-nums">{Number.isInteger(c.result) && c.result < 20 ? c.result : money(c.result)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {canReview && (
        <button
          onClick={() => onReview(dismissed ? "restore" : "dismiss")}
          disabled={busy}
          className="btn mt-3 min-h-11 rounded-xl border border-[var(--line-strong)] px-4 text-[15px] font-semibold text-[var(--muted)] disabled:opacity-50"
        >
          {dismissed ? "Put this back in the letter" : "This isn't an error"}
        </button>
      )}
    </li>
  );
}

function ChainRow({ e }: { e: ChainEvent }) {
  return (
    <li className="border-t border-[var(--line)] py-2">
      <div className="flex items-baseline gap-2">
        <span className="w-6 shrink-0 text-right text-[12px] tabular-nums text-[var(--faint)]">{e.seq}</span>
        <span className="text-[15px] font-semibold">{e.action}</span>
        <span className="ml-auto text-[12px] text-[var(--muted)]">{new Date(e.at).toLocaleTimeString()}</span>
      </div>
      <div className="pl-8 text-[13px] text-[var(--muted)]">
        by {e.actor} · <code>{e.hash.slice(0, 12)}</code>
      </div>
    </li>
  );
}

async function readFile(f: File): Promise<{ fileName: string; text: string }> {
  return { fileName: f.name, text: await f.text() };
}

export default function FinanceCasePage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [billFile, setBillFile] = useState<File | null>(null);
  const [eobFile, setEobFile] = useState<File | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = (await (await fetch("/api/finance/case", { cache: "no-store" })).json()) as Snapshot;
      setSnap(s);
      return s;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const c = snap?.case ?? null;
  const tracking = !!c?.submission && !c.resolution;
  useEffect(() => {
    if (!tracking) return;
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [tracking, refresh]);

  const post = useCallback(
    async (label: string, payload: Record<string, unknown>) => {
      setBusy(label);
      setMessage("");
      try {
        const res = await fetch("/api/finance/case", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok) setMessage(data.error ?? "Something went wrong.");
        else {
          if (data.record?.summary) setMessage(data.record.summary);
          if (data.record && data.record.status === "error") setMessage(data.record.error ?? data.record.summary);
          setSnap(data as Snapshot);
          setStarting(false);
        }
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const openWithFiles = async () => {
    if (!billFile || !eobFile) return;
    await post("open", { action: "open", documents: [await readFile(billFile), await readFile(eobFile)] });
  };

  const decide = async (decision: "approve" | "decline") => {
    if (!c) return;
    if (decision === "decline") return post("decline", { action: "decline", caseId: c.caseId });
    if (!snap?.approval) return;
    setBusy("approve");
    try {
      const res = await fetch(`/api/agents/finance/approvals/${snap.approval.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
      const data = await res.json();
      setMessage(data?.record?.summary ?? "Sent.");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const showUpload = !c || starting;
  const step = showUpload ? 1 : c.status === "awaiting_review" ? (snap?.approval ? 3 : 2) : c.submission ? 4 : 2;
  const r = c?.reconciliation;
  const canReview = c?.status === "awaiting_review";
  const visibleFindings = r?.findings ?? [];

  return (
    <main className="pb-36 text-[17px]">
      <header className="sticky top-0 z-30 rounded-b-[26px] px-4 pb-4 pt-4 text-white shadow-lg" style={{ background: ACCENT_BG }}>
        <div className="flex items-center gap-3">
          <Link href="/agents/finance" className="btn flex h-11 w-11 items-center justify-center rounded-full bg-white/25 ring-1 ring-inset ring-white/30" aria-label="Back to Finance">
            <ChevronLeftIcon width={22} height={22} />
          </Link>
          <h1 className="text-[24px] font-extrabold tracking-tight">Bill check</h1>
          {c && !showUpload && (
            <button onClick={() => setStarting(true)} className="btn ml-auto min-h-11 rounded-full bg-white/25 px-4 text-[15px] font-semibold ring-1 ring-inset ring-white/30">
              New check
            </button>
          )}
        </div>
        <StepDots step={step} />
      </header>

      <div aria-live="polite" className="px-4">
        {(message || busy === "open") && (
          <section className="card fade-up mt-4 p-4">
            <p className="text-[18px] leading-relaxed">{busy === "open" ? "Finance is reading both documents and comparing them line by line…" : message}</p>
          </section>
        )}
      </div>

      {loading && <p className="px-4 pt-6 text-center text-[var(--muted)]">Loading…</p>}

      {/* Step 1: upload */}
      {!loading && showUpload && (
        <section className="px-4" aria-labelledby="up-h">
          <div className="card mt-4 p-5">
            <h2 id="up-h" className="text-[20px] font-extrabold">
              Upload your bill and your insurance EOB
            </h2>
            <p className="mt-1 text-[16px] text-[var(--muted)]">Finance compares them line by line and shows you its evidence. Nothing is sent without your approval.</p>
            <label className="mt-4 block text-[16px] font-semibold" htmlFor="bill-file">
              1. Medical bill or statement (.txt)
            </label>
            <input id="bill-file" type="file" accept=".txt,text/plain" onChange={(e) => setBillFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-[15px]" />
            <label className="mt-3 block text-[16px] font-semibold" htmlFor="eob-file">
              2. Explanation of Benefits from insurance (.txt)
            </label>
            <input id="eob-file" type="file" accept=".txt,text/plain" onChange={(e) => setEobFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-[15px]" />
            <button
              onClick={() => void openWithFiles()}
              disabled={!billFile || !eobFile || !!busy}
              className="btn mt-4 min-h-14 w-full rounded-2xl text-[18px] font-bold text-white disabled:opacity-40"
              style={{ background: ACCENT_BG }}
            >
              Check these documents
            </button>
            <div className="my-4 flex items-center gap-3 text-[14px] text-[var(--muted)]">
              <span className="h-px flex-1 bg-[var(--line)]" /> or <span className="h-px flex-1 bg-[var(--line)]" />
            </div>
            <button
              onClick={() => void post("open", { action: "open", sample: true })}
              disabled={!!busy}
              className="btn min-h-14 w-full rounded-2xl text-[18px] font-bold disabled:opacity-50"
              style={{ background: SOFT, color: ACCENT }}
            >
              Use Margaret's sample documents
            </button>
            <p className="mt-2 text-center text-[14px] text-[var(--muted)]">
              Download them:{" "}
              <a className="underline" href="/samples/bayview-statement-2026-09.txt" download>
                hospital statement
              </a>{" "}
              ·{" "}
              <a className="underline" href="/samples/golden-state-eob-2026-09.txt" download>
                insurance EOB
              </a>
            </p>
          </div>
        </section>
      )}

      {c && !showUpload && r && (
        <>
          {/* Summary */}
          <section className="px-4" aria-labelledby="sum-h">
            <div className="card mt-4 p-4">
              <div className="flex items-baseline gap-2">
                <h2 id="sum-h" className="text-[20px] font-extrabold">
                  {c.title}
                </h2>
              </div>
              <p className="mt-0.5 text-[15px] font-semibold" style={{ color: ACCENT }}>
                {STATUS_TEXT[c.status]}
              </p>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-[var(--bg-tint)] p-2">
                  <dt className="text-[13px] text-[var(--muted)]">Hospital says</dt>
                  <dd className="text-[22px] font-extrabold tabular-nums">{money(r.billAmountDue)}</dd>
                </div>
                <div className="rounded-xl bg-[var(--bg-tint)] p-2">
                  <dt className="text-[13px] text-[var(--muted)]">Insurance says</dt>
                  <dd className="text-[22px] font-extrabold tabular-nums">{money(r.insurerSaysYouOwe)}</dd>
                </div>
                <div className="rounded-xl p-2" style={{ background: r.difference > 0 ? "#fee2e2" : "#d1fae5" }}>
                  <dt className="text-[13px] text-[var(--muted)]">Difference</dt>
                  <dd className="text-[22px] font-extrabold tabular-nums">{money(r.difference)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-[17px] leading-relaxed">{c.summary}</p>
              <p className="mt-1 text-[13px] text-[var(--faint)]">Summary written by {c.summaryBy === "claude" ? "Claude (amounts checked against the documents)" : "Finance's template"}.</p>
            </div>
          </section>

          {/* Findings */}
          {visibleFindings.length > 0 && (
            <section className="px-4" aria-labelledby="find-h">
              <div className="card mt-4 overflow-hidden">
                <div className="border-b border-[var(--line)] p-4">
                  <h2 id="find-h" className="text-[22px] font-extrabold">
                    What Finance found
                  </h2>
                  {canReview && <p className="text-[15px] text-[var(--muted)]">If something isn't really an error, take it out and the letter updates.</p>}
                </div>
                <ul>
                  {visibleFindings.map((f) => (
                    <FindingCard
                      key={f.findingId}
                      f={f}
                      canReview={!!canReview}
                      busy={!!busy}
                      onReview={(d) => void post(`review:${f.findingId}`, { action: "review", caseId: c.caseId, findingId: f.findingId, decision: d })}
                    />
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* Checks, observations, warnings */}
          <section className="px-4">
            <details className="card mt-4 p-4">
              <summary className="cursor-pointer text-[17px] font-bold">
                Checks that passed ({r.checks.filter((x) => x.passed).length} of {r.checks.length})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {r.checks.map((x) => (
                  <li key={x.check} className="text-[15px]">
                    <span aria-hidden>{x.passed ? "✅" : "❌"}</span> <span className="font-semibold">{x.check}</span>
                    <div className="pl-6 text-[13px] text-[var(--muted)]">{x.detail}</div>
                  </li>
                ))}
              </ul>
            </details>
            {c.observations.some((o) => !o.corroborated) && (
              <div className="card mt-3 p-4">
                <h3 className="text-[16px] font-bold">Claude also noticed (not supported by the numbers, so not in the letter)</h3>
                <ul className="mt-1 list-disc pl-5 text-[15px] text-[var(--muted)]">
                  {c.observations.filter((o) => !o.corroborated).map((o, i) => (
                    <li key={i}>{o.note}</li>
                  ))}
                </ul>
              </div>
            )}
            {c.warnings.length > 0 && (
              <div className="card mt-3 p-4" style={{ borderColor: "#fcd34d" }}>
                <h3 className="text-[16px] font-bold text-amber-900">Ignored for your safety</h3>
                <ul className="mt-1 list-disc pl-5 text-[15px] text-amber-900">
                  {c.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Draft + approval */}
          {c.draft && (
            <section className="px-4" aria-labelledby="draft-h">
              <div className="card mt-4 overflow-hidden">
                <div className="border-b border-[var(--line)] p-4">
                  <h2 id="draft-h" className="text-[22px] font-extrabold">
                    {c.draft.kind === "dispute" ? "Dispute letter" : "Clarification request"}
                  </h2>
                  <p className="text-[15px] text-[var(--muted)]">
                    Version {c.draft.version} · written by {c.draft.draftedBy === "claude" ? "Claude, checked against the evidence" : "Finance's template"} · fingerprint <code>{c.draft.draftHash}</code>
                  </p>
                </div>
                <dl className="space-y-1 p-4 text-[15px]">
                  <div>
                    <dt className="inline font-semibold">To: </dt>
                    <dd className="inline">
                      {c.draft.recipient.name} ({c.draft.recipient.email})
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">Subject: </dt>
                    <dd className="inline">{c.draft.subject}</dd>
                  </div>
                </dl>
                <pre className="mx-4 mb-4 whitespace-pre-wrap rounded-xl bg-[var(--bg-tint)] p-3 font-sans text-[15px] leading-relaxed">{c.draft.body}</pre>
              </div>

              {snap?.approval && c.status === "awaiting_review" && (
                <div className="card mt-4 p-4" style={{ borderColor: "#a7f3d0" }}>
                  <p id="approve-desc" className="text-[16px] leading-snug text-[var(--muted)]">
                    Nothing is sent until you tap Send. Your approval covers this exact letter (fingerprint {c.draft.draftHash}); if it changes, you'll be asked again.
                  </p>
                  <button
                    onClick={() => void decide("approve")}
                    disabled={!!busy}
                    aria-describedby="approve-desc"
                    className="btn mt-3 flex min-h-16 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-700 text-[20px] font-extrabold text-white shadow-md disabled:opacity-50"
                  >
                    <CheckIcon width={26} height={26} />
                    {busy === "approve" ? "Sending…" : "Approve and send"}
                  </button>
                  <button onClick={() => void decide("decline")} disabled={!!busy} className="btn mt-2 min-h-12 w-full rounded-2xl bg-[var(--bg-tint)] text-[17px] font-semibold text-[var(--ink)] disabled:opacity-50">
                    Don't send anything
                  </button>
                </div>
              )}
            </section>
          )}

          {r.nextSteps.length > 0 && c.status === "awaiting_review" && (
            <section className="px-4">
              <div className="card mt-4 p-4">
                <h2 className="text-[18px] font-extrabold">Suggested next steps</h2>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-[16px]">
                  {r.nextSteps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            </section>
          )}

          {/* Tracking */}
          {c.submission && (
            <section className="px-4" aria-labelledby="track-h">
              <div className="card mt-4 p-4">
                <h2 id="track-h" className="text-[22px] font-extrabold">
                  Case progress
                </h2>
                <p className="text-[15px] text-[var(--muted)]">Reference {c.submission.submissionRef} · sandbox billing office</p>
                <ol className="mt-3 space-y-3" aria-label="Case progress">
                  {(["submitted", "acknowledged", "under_review", "resolved"] as const).map((stage) => {
                    const u = c.updates.find((x) => x.stage === stage);
                    const labels = { submitted: "Sent", acknowledged: "Received by billing office", under_review: "Being reviewed", resolved: "Response received" };
                    return (
                      <li key={stage} className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: u ? "#047857" : "#eceff3", color: u ? "#fff" : "#6b7785" }} aria-hidden>
                          {u ? <CheckIcon width={20} height={20} /> : "•"}
                        </span>
                        <div>
                          <div className={`text-[18px] ${u ? "font-bold" : "text-[var(--muted)]"}`}>
                            {labels[stage]}
                            <span className="sr-only">{u ? " (done)" : " (not yet)"}</span>
                          </div>
                          {u?.message && <div className="text-[15px] text-[var(--muted)]">{u.message}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
                {c.resolution && (
                  <p className={`mt-4 rounded-xl p-3 text-[16px] leading-snug ${c.resolution.matches ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
                    {c.resolution.matches ? "✅ " : "⚠️ "}
                    {c.resolution.detail}
                  </p>
                )}
                {!c.resolution && (
                  <button onClick={() => void refresh()} className="btn mt-4 min-h-12 w-full rounded-2xl text-[17px] font-semibold" style={{ background: SOFT, color: ACCENT }}>
                    Check for a response
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Audit trail */}
          <section className="px-4" aria-labelledby="audit-h">
            <details className="card mt-4 p-4">
              <summary className="cursor-pointer">
                <span id="audit-h" className="text-[17px] font-bold">
                  Audit trail
                </span>{" "}
                <span className={`text-[15px] font-semibold ${snap?.chain?.ok ? "text-emerald-700" : "text-red-700"}`}>
                  {snap?.chain?.ok ? `✓ verified, ${snap.chain.length} entries` : `✗ broken at entry ${snap?.chain?.brokenAt}`}
                </span>
              </summary>
              <p className="mt-2 text-[14px] text-[var(--muted)]">Each entry is hash-chained to the one before it, so any later edit is detectable.</p>
              <ul className="mt-2">
                {c.chain.map((e) => (
                  <ChainRow key={e.seq} e={e} />
                ))}
              </ul>
              <a href="/api/finance/case?export=1" className="btn mt-3 inline-flex min-h-11 items-center rounded-xl px-4 text-[15px] font-semibold" style={{ background: SOFT, color: ACCENT }}>
                Download evidence packet (JSON)
              </a>
            </details>
          </section>
        </>
      )}

      {snap && (
        <section className="px-4 pt-5" aria-label="How this works">
          <ul className="space-y-1.5 text-[14px] leading-snug text-[var(--muted)]">
            {snap.integrations.map((i) => (
              <li key={i.key}>
                <span className="font-semibold text-[var(--ink)]">{i.label}</span>: {i.mode}. {i.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
