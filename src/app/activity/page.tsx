"use client";

import { useEffect, useState } from "react";
import type { AgentEvent } from "@/agents/base/types";

const AGENT_COLOR: Record<string, string> = {
  guardian: "#2563eb",
  care: "#059669",
  wellness: "#7c3aed",
  finance: "#d97706",
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
    <main className="px-5 pt-10">
      <h1 className="text-[26px] font-bold">Activity</h1>
      <p className="mt-1 text-[15px] text-[var(--muted)]">
        Every cross-agent request, and whether it was authorized. This is the audit trail of agent collaboration.
      </p>

      {loading && <p className="mt-6 text-[var(--muted)]">Loading…</p>}
      {!loading && events.length === 0 && (
        <p className="mt-6 text-[var(--muted)]">No cross-agent events yet. Try asking Wellness something urgent, or ordering groceries with Care.</p>
      )}

      <section className="mt-5 flex flex-col gap-3">
        {events.map((e) => {
          const s = STATUS_STYLE[e.status] ?? STATUS_STYLE.pending;
          return (
            <div key={e.id} className="card fade-up p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span style={{ color: AGENT_COLOR[e.sourceAgent] }}>{e.sourceAgent}</span>
                <span className="text-[var(--muted)]">→</span>
                <span style={{ color: AGENT_COLOR[e.targetAgent] }}>{e.targetAgent}</span>
                <span className="pill ml-auto px-2 py-0.5 text-[11px] font-semibold" style={{ background: s.bg, color: s.color }}>
                  {s.label}
                </span>
              </div>
              <div className="mt-1 text-[14px]">{e.type}</div>
              {e.reason && <div className="mt-1 text-[12px] text-[var(--muted)]">{e.reason}</div>}
              <div className="mt-1 text-[11px] text-[var(--muted)]">
                {new Date(e.createdAt).toLocaleString()} · corr {e.correlationId.slice(0, 10)}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
