"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentEvent, AgentId, AgentTask, Approval } from "@/agents/base/types";
import { WellnessTrendsCard } from "@/components/WellnessTrendsCard";

type PerAgent = Record<AgentId, { tasks: AgentTask[]; approvals: Approval[] }>;

interface FamilyFeed {
  perAgent: PerAgent;
  events: AgentEvent[];
  consent: Record<string, boolean>;
}

const SECTIONS: { id: AgentId; title: string; color: string; consentKey: string }[] = [
  { id: "guardian", title: "Guardian alerts", color: "#168b82", consentKey: "caregiverGuardian" },
  { id: "care", title: "Care reminders & tasks", color: "#4779b8", consentKey: "caregiverCare" },
  { id: "wellness", title: "Wellness summaries", color: "#c98a2e", consentKey: "caregiverWellness" },
  { id: "finance", title: "Finance approvals", color: "#5a6acf", consentKey: "caregiverFinance" },
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
      <main className="px-5 pt-8">
        <h1 className="text-[28px] font-extrabold tracking-tight">Family</h1>
        <section className="mt-6 flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-4">
              <div className="skeleton h-4 w-2/5" />
              <div className="skeleton mt-3 h-10 w-full" />
            </div>
          ))}
        </section>
      </main>
    );
  }

  const visibleSections = SECTIONS.filter((s) => filter === "all" || s.id === filter);

  return (
    <main className="px-5 pt-8">
      <h1 className="text-[28px] font-extrabold tracking-tight">Family dashboard</h1>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Permitted updates from each agent. Eleanor controls what caregivers can see.
      </p>

      {/* Filter */}
      <div className="mt-4 flex gap-2 overflow-x-auto scroll-hide pb-1">
        {(["all", "guardian", "care", "wellness", "finance"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="btn pill shrink-0 px-3.5 py-1.5 text-[13px] font-semibold capitalize"
            style={
              filter === f
                ? { background: "var(--brand-grad)", color: "#fff", boxShadow: "var(--shadow-brand)" }
                : { background: "#fff", border: "1px solid var(--line)", color: "var(--muted)" }
            }
          >
            {f === "all" ? "All" : f}
          </button>
        ))}
      </div>

      {/* Sections */}
      <section className="mt-5 flex flex-col gap-4">
        {visibleSections.map((s, i) => {
          const allowed = feed.consent[s.consentKey];
          const bucket = feed.perAgent[s.id];
          const items = [...(bucket?.tasks ?? [])];
          return (
            <div key={s.id} className={`card fade-up stagger-${Math.min(i + 1, 4)} p-4`}>
              <div className="flex items-center gap-2.5">
                <span className="h-7 w-7 rounded-lg" style={{ background: `${s.color}1a`, border: `1.5px solid ${s.color}` }} />
                <h2 className="text-[16px] font-bold tracking-tight">{s.title}</h2>
                <button
                  role="switch"
                  aria-checked={!!allowed}
                  onClick={() => toggleConsent(s.consentKey, !allowed)}
                  className="btn relative ml-auto h-6 w-11 shrink-0 rounded-full transition-colors"
                  style={{ background: allowed ? s.color : "#d7dae6" }}
                >
                  <span
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
                    style={{ left: allowed ? "22px" : "2px" }}
                  />
                </button>
              </div>

              {!allowed ? (
                <p className="mt-3 flex items-center gap-1.5 text-[13px] text-[var(--faint)]">
                  🔒 Hidden by Eleanor&apos;s consent settings.
                </p>
              ) : items.length === 0 ? (
                <p className="mt-3 text-[13px] text-[var(--faint)]">Nothing to show yet.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {items.slice(0, 6).map((t) => (
                    <li key={t.id} className="rounded-xl p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                      <div className="text-[14px] font-semibold">{t.title}</div>
                      <div className="mt-0.5 text-[12px] text-[var(--muted)]">
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

      {(filter === "all" || filter === "wellness") && feed.consent.caregiverWellness && (
        <section className="mt-6">
          <h2 className="eyebrow">Wellness trends</h2>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Weekly sleep and energy from Eleanor&apos;s own reports, compared with her usual. Numbers only; conversations stay private.
          </p>
          <WellnessTrendsCard audience="family" refreshToken={String(feed.consent.caregiverWellnessRaw)} />
        </section>
      )}

      <p className="mt-6 text-center text-[12px] text-[var(--faint)]">
        Caregiver access respects the older adult&apos;s consent (prompt §8).
      </p>
    </main>
  );
}
