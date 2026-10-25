"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkItem, GateResult } from "@/agents/base/workItems";

type Row = WorkItem & { chainIntact: boolean; gate: GateResult };
interface Payload {
  backend: "sandbox" | "jira";
  jira: { mode: string; detail: string };
  identityMode: "live" | "sandbox";
  reviewers: { id: string; name: string; roles: string[] }[];
  items: Row[];
}

const AGENT_COLOR: Record<string, string> = {
  guardian: "#168b82",
  care: "#4779b8",
  wellness: "#c98a2e",
  finance: "#5a6acf",
};

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  in_review: { bg: "#e5e7eb", color: "#374151" },
  approved: { bg: "#dbeafe", color: "#1e40af" },
  executed: { bg: "#d1fae5", color: "#065f46" },
  rejected: { bg: "#fee2e2", color: "#991b1b" },
  expired: { bg: "#fef3c7", color: "#92400e" },
  requested: { bg: "#e5e7eb", color: "#374151" },
};

const DENIED = new Set(["delegation_denied", "approval_denied", "execution_denied", "external_decision_ignored", "execution_failed"]);

export default function ApprovalsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [actingAs, setActingAs] = useState("sarah");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = (await fetch("/api/work-items").then((r) => r.json())) as Payload;
    setData(d);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const r = await fetch("/api/work-items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      setNotice(r.record?.summary ?? r.reason ?? (r.ok ? "Done." : r.error ?? "Refused."));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="px-5 pt-8 pb-32">
      <h1 className="text-[28px] font-extrabold tracking-tight">Approvals</h1>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        When one agent needs another to do something sensitive, it becomes a work item. Nothing runs until the right family members approve, and every step is recorded in a tamper-evident trail.
      </p>

      {data && (
        <div className="card mt-4 p-4 text-[13px] leading-relaxed">
          <div>
            <b>Review backend:</b> {data.backend === "jira" ? "Atlassian Jira (live)" : "local store (sandbox)"}
          </div>
          <div className="text-[var(--muted)]">{data.jira.detail}</div>
          <label className="mt-3 flex items-center gap-2">
            <b>Acting as</b>
            <select className="rounded-lg border px-2 py-1" value={actingAs} onChange={(e) => setActingAs(e.target.value)}>
              {data.reviewers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.roles.join(", ")})
                </option>
              ))}
            </select>
          </label>
          {data.identityMode === "sandbox" && (
            <div className="mt-1 text-[12px] text-[var(--faint)]">Sandbox identities for the demo. Roles are looked up server-side, never taken from this picker.</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => act({ action: "propose" })} className="btn rounded-xl bg-[var(--brand)] px-3 py-1.5 font-semibold text-white">
              Guardian: request $1,800 payment
            </button>
            <button disabled={busy} onClick={() => act({ action: "propose", scenario: "small" })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 font-semibold">
              Guardian: request $86 dispute
            </button>
          </div>
        </div>
      )}

      {notice && <div className="card mt-3 p-3 text-[13px]" role="status">{notice}</div>}

      <section className="mt-5 flex flex-col gap-3">
        {data?.items.length === 0 && (
          <div className="card p-6 text-center text-[14px] text-[var(--muted)]">No work items yet. Ask Guardian to request a payment above.</div>
        )}
        {data?.items.map((i) => {
          const s = STATUS_STYLE[i.status] ?? STATUS_STYLE.requested;
          const reviewable = i.status === "in_review";
          return (
            <div key={i.id} className="card p-4">
              <div className="flex items-center gap-2 text-[13px] font-bold">
                <span className="pill px-2 py-0.5 text-[12px]" style={{ background: `${AGENT_COLOR[i.requestingAgent]}18`, color: AGENT_COLOR[i.requestingAgent] }}>
                  {i.requestingAgent}
                </span>
                <span className="text-[var(--faint)]">→</span>
                <span className="pill px-2 py-0.5 text-[12px]" style={{ background: `${AGENT_COLOR[i.assignedAgent]}18`, color: AGENT_COLOR[i.assignedAgent] }}>
                  {i.assignedAgent}
                </span>
                <span className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold" style={{ background: s.bg, color: s.color }}>
                  {i.status.replace("_", " ")}
                </span>
              </div>
              <div className="mt-2 text-[15px] font-semibold">{i.requestedAction}</div>
              <div className="mt-1 text-[12px] text-[var(--muted)]">
                {i.toolName} · {i.permissionScope} · {i.riskTier} risk · approvals {i.approvals.length}/{i.requiredApprovals} {i.requiredRole}
                {i.externalKey ? ` · Jira ${i.externalKey}` : ""}
              </div>
              <div className="mt-1 text-[12px]" style={{ color: i.gate.ok ? "#065f46" : "#6b7280" }}>
                Gate: {i.gate.ok ? "ready to execute" : i.gate.reason}
                {!i.chainIntact && <b className="ml-1 text-red-600">Audit chain broken</b>}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {reviewable && (
                  <>
                    <button disabled={busy} onClick={() => act({ action: "approve", workItemId: i.id, reviewerId: actingAs })} className="btn rounded-xl bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-white">
                      Approve
                    </button>
                    <button disabled={busy} onClick={() => act({ action: "reject", workItemId: i.id, reviewerId: actingAs })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold text-red-600">
                      Reject
                    </button>
                  </>
                )}
                {(i.status === "approved" || reviewable) && (
                  <button disabled={busy} onClick={() => act({ action: "execute", workItemId: i.id })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold">
                    Finance: execute
                  </button>
                )}
                {data.backend === "jira" && i.externalKey && reviewable && (
                  <button disabled={busy} onClick={() => act({ action: "sync", workItemId: i.id })} className="btn rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[13px] font-semibold">
                    Sync from Jira
                  </button>
                )}
                <button onClick={() => setOpen(open === i.id ? null : i.id)} className="btn ml-auto rounded-xl px-2 py-1.5 text-[13px] text-[var(--muted)]">
                  {open === i.id ? "Hide history" : `History (${i.history.length})`}
                </button>
              </div>

              {open === i.id && (
                <ol className="mt-3 flex flex-col gap-1.5 border-t pt-3 text-[12px]">
                  {i.history.map((e, n) => (
                    <li key={n} className="flex gap-2">
                      <code className="shrink-0 text-[var(--faint)]">{e.hash?.slice(0, 8)}</code>
                      <span>
                        <b style={{ color: DENIED.has(e.action) ? "#b91c1c" : undefined }}>{e.actor}</b> {e.action.replace(/_/g, " ")}
                        {e.detail ? <span className="text-[var(--muted)]">: {e.detail}</span> : null}
                        <span className="ml-1 text-[var(--faint)]">{new Date(e.at).toLocaleTimeString()}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
