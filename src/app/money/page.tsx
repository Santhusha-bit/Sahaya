"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";
import type { SpendingAnalysis, SuggestedAction } from "@/agents/finance/nessie/service";
import { ChevronLeftIcon } from "@/components/icons";
import { speak } from "@/lib/speech";

interface Snapshot {
  connection: null | { status: "authorized" | "revoked"; nickname: string; last4: string; backend: "live" | "sandbox"; authorizedAt: number };
  approval: null | { id: string; title: string; description: string };
  analysis: null | Omit<SpendingAnalysis, "seenTransactionIds">;
  suggestions: (SuggestedAction & { id: string })[];
  integrations: IntegrationStatus[];
}

const ACCENT = "#3b449c";
const ACCENT_BG = "linear-gradient(135deg,#4a59bc,#5a6acf)";

function money(n: number | undefined) {
  return `$${(n ?? 0).toFixed(2)}`;
}

function monthName(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
}

const ACCEPT_LABEL: Record<SuggestedAction["kind"], string> = {
  dispute_duplicate: "Draft a dispute",
  review_subscription: "I want to cancel it",
  check_price_increase: "Remind me to ask",
};
const DISMISS_LABEL: Record<SuggestedAction["kind"], string> = {
  dispute_duplicate: "It's fine",
  review_subscription: "Keep it",
  check_price_increase: "It's fine",
};

export default function MoneyPage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [says, setSays] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [error, setError] = useState("");
  const [customMerchant, setCustomMerchant] = useState("");
  const [customAmount, setCustomAmount] = useState("");

  const say = useCallback(
    (text: string) => {
      setSays(text);
      if (voiceOn && text) void speak(text);
    },
    [voiceOn],
  );

  const refresh = useCallback(async () => {
    const s = (await (await fetch("/api/finance/bank", { cache: "no-store" })).json()) as Snapshot;
    setSnap(s);
    return s;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (key: string, body: Record<string, unknown>) => {
      if (busy) return null;
      setBusy(key);
      setError("");
      try {
        const res = await fetch("/api/finance/bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error ?? "Something went wrong.");
          return null;
        }
        setSnap(data as Snapshot);
        return data as Snapshot & { record?: { summary?: string; status?: string }; simulated?: { merchant: string; amount: number; date: string } };
      } catch {
        setError("Couldn't reach Finance. Please try again.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const decideAccess = useCallback(
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
        await refresh();
        say(decision === "approve" ? (data?.record?.summary ?? "Connected.") : "Okay, I won't look at your account.");
      } finally {
        setBusy(null);
      }
    },
    [snap, busy, refresh, say],
  );

  const connected = snap?.connection?.status === "authorized";
  const a = snap?.analysis ?? null;
  const pending = snap?.suggestions.filter((s) => s.status === "suggested") ?? [];
  const decided = snap?.suggestions.filter((s) => s.status !== "suggested") ?? [];
  const nessie = snap?.integrations.find((i) => i.key === "nessie");

  return (
    <main className="pb-36 text-[17px]">
      <header className="sticky top-0 z-30 rounded-b-[26px] px-4 pb-4 pt-4 text-white shadow-lg" style={{ background: ACCENT_BG }}>
        <div className="flex items-center gap-3">
          <Link
            href="/agents/finance"
            className="btn flex h-11 w-11 items-center justify-center rounded-full bg-white/25 ring-1 ring-inset ring-white/30"
            aria-label="Back to Finance"
          >
            <ChevronLeftIcon width={22} height={22} />
          </Link>
          <h1 className="text-[24px] font-extrabold tracking-tight">My spending</h1>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className="btn ml-auto min-h-11 rounded-full bg-white/25 px-4 text-[15px] font-semibold ring-1 ring-inset ring-white/30"
            aria-pressed={voiceOn}
          >
            {voiceOn ? "🔊 Voice on" : "🔈 Voice off"}
          </button>
        </div>
        <p className="mt-2 text-[15px] text-white/90">Finance reads your checking account and tells you what it sees. It never moves money.</p>
      </header>

      <div aria-live="polite" className="px-4">
        {(says || error) && (
          <section className="card fade-up mt-4 p-4">
            {says && <p className="text-[18px] leading-relaxed">{says}</p>}
            {error && <p className="mt-1 text-[16px] font-semibold text-[#b42318]">{error}</p>}
          </section>
        )}
      </div>

      {/* Account access */}
      <section className="px-4" aria-labelledby="acct-h">
        <div className="card mt-4 p-4">
          <h2 id="acct-h" className="text-[20px] font-extrabold">
            Bank account
          </h2>
          {!snap && <p className="mt-2 text-[var(--muted)]">Loading…</p>}
          {snap && connected && snap.connection && (
            <div className="mt-2">
              <p className="text-[18px] font-bold">
                {snap.connection.nickname} ending {snap.connection.last4}
              </p>
              <p className="text-[15px] text-[var(--muted)]">
                Capital One {snap.connection.backend === "live" ? "Nessie sandbox" : "Nessie (local emulator)"} · read-only
              </p>
              <button
                onClick={() => void act("disconnect", { action: "disconnect" }).then((d) => d && say(d.record?.summary ?? "Disconnected."))}
                disabled={!!busy}
                className="btn mt-3 min-h-11 rounded-xl border border-[var(--line-strong)] px-4 text-[15px] font-semibold text-[var(--muted)] disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          )}
          {snap && !connected && !snap.approval && (
            <>
              <p className="mt-2 text-[16px] leading-snug">
                {snap.connection?.status === "revoked" ? "Finance's access is turned off." : "Finance needs your OK to read your checking account."}
              </p>
              <button
                onClick={() => void act("connect", { action: "connect" })}
                disabled={!!busy}
                className="btn mt-3 min-h-14 w-full rounded-2xl text-[18px] font-bold text-white disabled:opacity-50"
                style={{ background: ACCENT_BG }}
              >
                {busy === "connect" ? "Asking…" : "Connect my checking account"}
              </button>
            </>
          )}
          {snap?.approval && (
            <div className="mt-3 rounded-2xl border-2 p-4" style={{ borderColor: ACCENT }}>
              <p className="text-[18px] font-extrabold">{snap.approval.title}</p>
              <p className="mt-1 text-[16px] leading-snug">{snap.approval.description}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  onClick={() => void decideAccess("approve")}
                  disabled={!!busy}
                  className="btn min-h-14 rounded-xl text-[17px] font-bold text-white disabled:opacity-50"
                  style={{ background: ACCENT }}
                >
                  {busy === "approve" ? "Connecting…" : "Allow"}
                </button>
                <button
                  onClick={() => void decideAccess("reject")}
                  disabled={!!busy}
                  className="btn min-h-14 rounded-xl border border-[var(--line-strong)] text-[17px] font-bold disabled:opacity-50"
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {connected && (
        <section className="px-4">
          <button
            onClick={() => void act("analyze", { action: "analyze" }).then((d) => d?.analysis && say(d.analysis.spoken))}
            disabled={!!busy}
            className="btn mt-4 min-h-16 w-full rounded-2xl text-[19px] font-bold text-white shadow-md disabled:opacity-50"
            style={{ background: ACCENT_BG }}
          >
            {busy === "analyze" ? "Finance is reviewing…" : a ? "Review my spending again" : "Review my spending"}
          </button>
        </section>
      )}

      {/* New since last review */}
      {a && !a.firstRun && (
        <section className="px-4" aria-labelledby="new-h">
          <div className="card mt-4 p-4" style={a.newTransactions.length ? { outline: `3px solid ${ACCENT}` } : undefined}>
            <h2 id="new-h" className="text-[20px] font-extrabold">
              New since last review
            </h2>
            {a.newTransactions.length === 0 ? (
              <p className="mt-1 text-[16px] text-[var(--muted)]">No new charges.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {a.newTransactions.map((t) => (
                  <li key={t.id} className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[18px] font-bold">{t.merchant}</p>
                      <p className="text-[15px] text-[var(--muted)]">{t.date}</p>
                      {t.flags.map((f) => (
                        <span key={f} className="pill mr-1 mt-1 inline-block px-2.5 py-0.5 text-[13px] font-bold" style={{ background: "#fef3c7", color: "#7c4a03" }}>
                          {f}
                        </span>
                      ))}
                    </div>
                    <span className="text-[19px] font-bold tabular-nums">{money(t.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Suggestions */}
      {a && (
        <section className="px-4" aria-labelledby="sugg-h">
          <div className="card mt-4 overflow-hidden">
            <h2 id="sugg-h" className="border-b border-[var(--line)] p-4 text-[20px] font-extrabold">
              Suggestions for you {pending.length > 0 && <span className="text-[16px] font-semibold text-[var(--muted)]">({pending.length})</span>}
            </h2>
            {pending.length === 0 && <p className="p-4 text-[16px] text-[var(--muted)]">Nothing waiting on you.</p>}
            <ul>
              {pending.map((s) => (
                <li key={s.id} className="border-b border-[var(--line)] p-4">
                  <p className="text-[18px] font-bold leading-snug">{s.title}</p>
                  <p className="mt-1 text-[16px] leading-snug">{s.detail}</p>
                  {s.note && <p className="mt-1.5 text-[15px] italic text-[var(--muted)]">Finance's note: {s.note}</p>}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => void act(`accept:${s.id}`, { action: "decide", actionId: s.id, decision: "accept" }).then((d) => d && say(d.record?.summary ?? ""))}
                      disabled={!!busy}
                      className="btn min-h-12 rounded-xl text-[16px] font-bold text-white disabled:opacity-50"
                      style={{ background: ACCENT }}
                    >
                      {ACCEPT_LABEL[s.kind]}
                    </button>
                    <button
                      onClick={() => void act(`dismiss:${s.id}`, { action: "decide", actionId: s.id, decision: "dismiss" }).then((d) => d && say(d.record?.summary ?? ""))}
                      disabled={!!busy}
                      className="btn min-h-12 rounded-xl border border-[var(--line-strong)] text-[16px] font-bold disabled:opacity-50"
                    >
                      {DISMISS_LABEL[s.kind]}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {decided.length > 0 && (
              <details className="p-4">
                <summary className="cursor-pointer text-[16px] font-semibold" style={{ color: ACCENT }}>
                  Already decided ({decided.length})
                </summary>
                <ul className="mt-2 space-y-2">
                  {decided.map((s) => (
                    <li key={s.id} className="text-[15px]">
                      <span className="font-semibold">{s.status === "accepted" ? "✓" : "✕"} {s.title}.</span> {s.outcome}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      {/* Monthly summary */}
      {a && (
        <section className="px-4" aria-labelledby="sum-h">
          <div className="card mt-4 p-4">
            <h2 id="sum-h" className="text-[20px] font-extrabold">
              {monthName(a.month)} so far
            </h2>
            <p className="mt-1 text-[34px] font-extrabold tabular-nums" style={{ color: ACCENT }}>
              {money(a.summary.total)}
            </p>
            <p className="text-[16px] text-[var(--muted)]">
              {a.summary.transactionCount} purchases · {monthName(a.summary.previousMonth)} total was {money(a.summary.previousTotal)}
            </p>
            <table className="mt-3 w-full text-[16px]">
              <caption className="sr-only">Spending by category</caption>
              <thead>
                <tr className="text-left text-[14px] text-[var(--muted)]">
                  <th className="pb-1 font-semibold">Category</th>
                  <th className="pb-1 text-right font-semibold">{monthName(a.month).slice(0, 3)}</th>
                  <th className="pb-1 text-right font-semibold">{monthName(a.summary.previousMonth).slice(0, 3)}</th>
                </tr>
              </thead>
              <tbody>
                {a.summary.byCategory.map((c) => (
                  <tr key={c.category} className="border-t border-[var(--line)]">
                    <td className="py-1.5">{c.label}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{money(c.total)}</td>
                    <td className="py-1.5 text-right tabular-nums text-[var(--muted)]">{money(c.previousTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[15px] text-[var(--muted)]">
              Regular monthly charges: <span className="font-semibold text-[var(--ink)]">{money(a.summary.recurringMonthlyTotal)}/month</span> ({a.subscriptions.length})
            </p>
            <p className="mt-1 text-[13px] text-[var(--muted)]">
              Categories by {a.reviewer === "claude" ? "Claude, checked in code" : "built-in rules"}. {a.reviewerNote ?? ""}
            </p>
          </div>
        </section>
      )}

      {/* Demo: the bank posts a new purchase */}
      {connected && (
        <section className="px-4" aria-labelledby="demo-h">
          <details className="card mt-4 p-4">
            <summary id="demo-h" className="cursor-pointer text-[16px] font-bold" style={{ color: ACCENT }}>
              Demo: add a sandbox transaction
            </summary>
            <p className="mt-2 text-[15px] text-[var(--muted)]">
              Plays the bank posting a new card purchase to the sandbox account. Then tap “Review my spending again” to watch Finance catch it.
            </p>
            <button
              onClick={() =>
                void act("sim", { action: "simulate", scenario: "double_charge" }).then(
                  (d) => d?.simulated && say(`The bank posted ${d.simulated.merchant} ${money(d.simulated.amount)} on ${d.simulated.date}. Run the review again to see if Finance notices.`),
                )
              }
              disabled={!!busy}
              className="btn mt-3 min-h-12 w-full rounded-xl border-2 text-[16px] font-bold disabled:opacity-50"
              style={{ borderColor: ACCENT, color: ACCENT }}
            >
              Post a double charge
            </button>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act("sim", { action: "simulate", scenario: "custom", merchant: customMerchant, amount: Number(customAmount) }).then((d) => {
                  if (d?.simulated) {
                    say(`The bank posted ${d.simulated.merchant} ${money(d.simulated.amount)}. Run the review again.`);
                    setCustomMerchant("");
                    setCustomAmount("");
                  }
                });
              }}
            >
              <label className="sr-only" htmlFor="sim-m">
                Merchant
              </label>
              <input
                id="sim-m"
                value={customMerchant}
                onChange={(e) => setCustomMerchant(e.target.value)}
                placeholder="Merchant"
                className="min-h-12 min-w-0 flex-1 rounded-xl border border-[var(--line-strong)] bg-white px-3 text-[16px]"
              />
              <label className="sr-only" htmlFor="sim-a">
                Amount
              </label>
              <input
                id="sim-a"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                inputMode="decimal"
                placeholder="$"
                className="min-h-12 w-24 rounded-xl border border-[var(--line-strong)] bg-white px-3 text-[16px]"
              />
              <button
                type="submit"
                disabled={!!busy || !customMerchant.trim() || !(Number(customAmount) > 0)}
                className="btn min-h-12 rounded-xl px-4 text-[16px] font-bold text-white disabled:opacity-40"
                style={{ background: ACCENT }}
              >
                Add
              </button>
            </form>
          </details>
        </section>
      )}

      {snap && (
        <footer className="px-4 pt-5 text-[13px] leading-snug text-[var(--muted)]">
          {snap.integrations.map((i) => (
            <p key={i.key} className="mt-1">
              <span className="font-semibold">{i.label}:</span> {i.detail}
            </p>
          ))}
          {nessie?.mode === "sandbox" && <p className="mt-1">No real bank or money is involved.</p>}
        </footer>
      )}
    </main>
  );
}
