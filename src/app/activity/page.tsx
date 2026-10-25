"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentEvent } from "@/agents/base/types";

const AGENT_COLOR: Record<string, string> = {
  guardian: "#168b82",
  care: "#4779b8",
  wellness: "#c98a2e",
  finance: "#5a6acf",
};

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  accepted: { bg: "#d1fae5", color: "#065f46", label: "delivered" },
  completed: { bg: "#d1fae5", color: "#065f46", label: "completed" },
  blocked: { bg: "#fee2e2", color: "#991b1b", label: "blocked" },
  rejected: { bg: "#fef3c7", color: "#92400e", label: "rejected" },
  pending: { bg: "#e5e7eb", color: "#374151", label: "pending" },
};

export default function ActivityPage() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/events")
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="px-5 pt-8">
      <h1 className="text-[28px] font-extrabold tracking-tight">Activity</h1>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Every cross-agent request, and whether it was authorized. This is the audit trail of agent collaboration.
      </p>
      <Link href="/approvals" className="card card-interactive mt-4 flex items-center justify-between p-4 text-[14px] font-semibold">
        <span>Approvals: sensitive hand-offs waiting on family review</span>
        <span className="text-[var(--faint)]">→</span>
      </Link>

      {loading && (
        <section className="mt-6 flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-4">
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton mt-2 h-3 w-3/4" />
            </div>
          ))}
        </section>
      )}
      {!loading && events.length === 0 && (
        <div className="card mt-6 p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--brand-soft)] text-[22px]">🔗</div>
          <p className="text-[14px] leading-relaxed text-[var(--muted)]">
            No cross-agent events yet. Try asking Wellness something urgent, or ordering groceries with Care.
          </p>
        </div>
      )}

      <section className="mt-5 flex flex-col gap-3">
        {events.map((e, i) => {
          const s = STATUS_STYLE[e.status] ?? STATUS_STYLE.pending;
          return (
            <div key={e.id} className={`card card-interactive fade-up stagger-${Math.min(i + 1, 4)} p-4`}>
              <div className="flex items-center gap-2 text-[13px] font-bold">
                <span className="pill px-2 py-0.5 text-[12px]" style={{ background: `${AGENT_COLOR[e.sourceAgent]}18`, color: AGENT_COLOR[e.sourceAgent] }}>
                  {e.sourceAgent}
                </span>
                <span className="text-[var(--faint)]">→</span>
                <span className="pill px-2 py-0.5 text-[12px]" style={{ background: `${AGENT_COLOR[e.targetAgent]}18`, color: AGENT_COLOR[e.targetAgent] }}>
                  {e.targetAgent}
                </span>
                <span className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold" style={{ background: s.bg, color: s.color }}>
                  {s.label}
                </span>
              </div>
              <div className="mt-2 text-[14px] font-medium">{e.type}</div>
              {e.reason && <div className="mt-1 text-[12px] leading-snug text-[var(--muted)]">{e.reason}</div>}
              <div className="mt-2 text-[11px] text-[var(--faint)]">
                {new Date(e.createdAt).toLocaleString()} · corr {e.correlationId.slice(0, 10)}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
