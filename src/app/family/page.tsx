"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentEvent, AgentId, AgentTask, Approval } from "@/agents/base/types";

type PerAgent = Record<AgentId, { tasks: AgentTask[]; approvals: Approval[] }>;

interface FamilyFeed {
  perAgent: PerAgent;
  events: AgentEvent[];
  consent: Record<string, boolean>;
}

const SECTIONS: { id: AgentId; title: string; color: string; consentKey: string }[] = [
  { id: "guardian", title: "Guardian alerts", color: "#2563eb", consentKey: "caregiverGuardian" },
  { id: "care", title: "Care reminders & tasks", color: "#059669", consentKey: "caregiverCare" },
  { id: "wellness", title: "Wellness summaries", color: "#7c3aed", consentKey: "caregiverWellness" },
  { id: "finance", title: "Finance approvals", color: "#d97706", consentKey: "caregiverFinance" },
];

export default function FamilyPage() {
  const [feed, setFeed] = useState<FamilyFeed | null>(null);
  const [filter, setFilter] = useState<AgentId | "all">("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch("/api/family")
      .then((r) => r.json())
      .then((d: FamilyFeed) => setFeed(d))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const toggleConsent = useCallback(
    async (key: string, value: boolean) => {
      await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      load();
    },
    [load],
  );

  if (loading || !feed) {
    return (
      <main className="px-5 pt-10">
        <h1 className="text-[26px] font-bold">Family</h1>
        <p className="mt-6 text-[var(--muted)]">Loading…</p>
      </main>
    );
  }

  const visibleSections = SECTIONS.filter((s) => filter === "all" || s.id === filter);

  return (
    <main className="px-5 pt-10">
      <h1 className="text-[26px] font-bold">Family dashboard</h1>
      <p className="mt-1 text-[15px] text-[var(--muted)]">
        Permitted updates from each agent. Eleanor controls what caregivers can see.
      </p>

      {/* Filter */}
      <div className="mt-4 flex gap-2 overflow-x-auto scroll-hide">
        {(["all", "guardian", "care", "wellness", "finance"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="btn pill shrink-0 px-3 py-1.5 text-[13px] font-semibold"
            style={filter === f ? { background: "#1a1f36", color: "#fff" } : { background: "#fff", border: "1px solid var(--line)" }}
          >
            {f === "all" ? "All" : f}
          </button>
        ))}
      </div>

      {/* Sections */}
      <section className="mt-5 flex flex-col gap-4">
        {visibleSections.map((s) => {
          const allowed = feed.consent[s.consentKey];
          const bucket = feed.perAgent[s.id];
          const items = [...(bucket?.tasks ?? [])];
          return (
            <div key={s.id} className="card p-4">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
                <h2 className="text-[16px] font-bold">{s.title}</h2>
                <label className="ml-auto flex items-center gap-1 text-[12px] text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={!!allowed}
                    onChange={(e) => toggleConsent(s.consentKey, e.target.checked)}
                  />
                  visible
                </label>
              </div>

              {!allowed ? (
                <p className="mt-2 text-[13px] text-[var(--muted)]">Hidden by Eleanor's consent settings.</p>
              ) : items.length === 0 ? (
                <p className="mt-2 text-[13px] text-[var(--muted)]">Nothing to show yet.</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {items.slice(0, 6).map((t) => (
                    <li key={t.id} className="rounded-xl bg-[var(--bg)] p-2.5">
                      <div className="text-[14px] font-medium">{t.title}</div>
                      <div className="text-[12px] text-[var(--muted)]">
                        {t.status.replace("_", " ")}
                        {t.result ? ` · ${t.result}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <p className="mt-6 text-center text-[12px] text-[var(--muted)]">
        Caregiver access respects the older adult's consent (prompt §8).
      </p>
    </main>
  );
}
