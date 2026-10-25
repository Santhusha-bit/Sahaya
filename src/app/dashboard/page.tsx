"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { IntegrationStatus } from "@/lib/env";
import { BrandLogo } from "@/components/BrandLogo";

interface StatusResponse {
  user: { name: string; role: string; authMode: string };
  backend: string;
  integrations: IntegrationStatus[];
}

const MODE_STYLE: Record<string, { bg: string; color: string; dot: string; label: string }> = {
  live: { bg: "#d1fae5", color: "#065f46", dot: "#10b981", label: "live" },
  sandbox: { bg: "#fef3c7", color: "#92400e", dot: "#f59e0b", label: "sandbox" },
  unavailable: { bg: "#fee2e2", color: "#991b1b", dot: "#ef4444", label: "unavailable" },
};

export default function DashboardPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const integrations = status?.integrations ?? [];
  const counts = integrations.reduce(
    (acc, i) => {
      acc[i.mode] = (acc[i.mode] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <main className="px-5 pt-8">
      <div className="flex items-center gap-2">
        <Link
          href="/profile"
          className="btn flex h-9 w-9 items-center justify-center rounded-full bg-white text-[18px] text-[var(--muted)] shadow-sm"
          style={{ border: "1px solid var(--line)" }}
          aria-label="Back"
        >
          ‹
        </Link>
        <h1 className="text-[28px] font-extrabold tracking-tight">Service status</h1>
      </div>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Current health of every external integration powering Sahaya.
      </p>

      {/* Summary */}
      <section className="mt-5 grid grid-cols-3 gap-2.5">
        {(["live", "sandbox", "unavailable"] as const).map((mode) => {
          const s = MODE_STYLE[mode];
          return (
            <div key={mode} className="card flex flex-col items-center gap-1 p-3.5 text-center">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.dot }} />
              <div className="text-[22px] font-extrabold tracking-tight">{counts[mode] ?? 0}</div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{s.label}</div>
            </div>
          );
        })}
      </section>

      {/* Backend */}
      {status && (
        <div className="card mt-4 flex items-center gap-2 p-3.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: status.backend === "convex" ? "#10b981" : "#f59e0b" }} />
          <div className="text-[14px] font-bold tracking-tight">Data backend</div>
          <div className="ml-auto text-[14px] capitalize text-[var(--muted)]">
            {status.backend === "convex" ? "Convex · live" : "Sandbox · in-process"}
          </div>
        </div>
      )}

      {/* Integrations */}
      <h2 className="eyebrow mt-7">Integrations</h2>
      <section className="mt-3 flex flex-col gap-2.5">
        {loading && <div className="text-[14px] text-[var(--muted)]">Checking services…</div>}
        {!loading && integrations.length === 0 && (
          <div className="text-[14px] text-[var(--muted)]">No service information available.</div>
        )}
        {integrations.map((i, idx) => {
          const s = MODE_STYLE[i.mode];
          return (
            <div key={i.key} className={`card fade-up stagger-${Math.min(idx + 1, 4)} p-3.5`}>
              <div className="flex items-center gap-2">
                <BrandLogo brandKey={i.key} label={i.label} />
                <div className="text-[15px] font-bold tracking-tight">{i.label}</div>
                <span
                  className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide"
                  style={{ background: s?.bg, color: s?.color }}
                >
                  {i.mode}
                </span>
              </div>
              <div className="mt-1 text-[13px] leading-snug text-[var(--muted)]">{i.detail}</div>
            </div>
          );
        })}
      </section>

      <p className="mt-6 text-center text-[12px] text-[var(--faint)]">
        Sahaya · honest status of every external service.
      </p>
    </main>
  );
}
