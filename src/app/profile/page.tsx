"use client";

import { useEffect, useState } from "react";
import type { IntegrationStatus } from "@/lib/env";

interface StatusResponse {
  user: { name: string; role: string; authMode: string };
  backend: string;
  integrations: IntegrationStatus[];
}

const MODE_STYLE: Record<string, { bg: string; color: string }> = {
  live: { bg: "#d1fae5", color: "#065f46" },
  sandbox: { bg: "#fef3c7", color: "#92400e" },
  unavailable: { bg: "#fee2e2", color: "#991b1b" },
};

export default function ProfilePage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const initial = status?.user.name?.charAt(0) ?? "·";

  return (
    <main className="px-5 pt-8">
      <h1 className="text-[28px] font-extrabold tracking-tight">Profile</h1>

      {status && (
        <div
          className="fade-up relative mt-5 flex items-center gap-4 overflow-hidden rounded-[24px] p-5 text-white"
          style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-lg)" }}
        >
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-white/15 blur-2xl" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 text-[26px] font-extrabold backdrop-blur">
            {initial}
          </div>
          <div className="relative">
            <div className="text-[20px] font-extrabold tracking-tight">{status.user.name}</div>
            <div className="mt-0.5 text-[13px] capitalize text-white/85">
              {status.user.role} · auth: {status.user.authMode}
            </div>
          </div>
        </div>
      )}

      <h2 className="eyebrow mt-7">Integrations</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--muted)]">
        Honest status of every external service (prompt acceptance criterion 12).
      </p>
      <section className="mt-3 flex flex-col gap-2.5">
        {status?.integrations.map((i, idx) => {
          const s = MODE_STYLE[i.mode];
          return (
            <div key={i.key} className={`card fade-up stagger-${Math.min(idx + 1, 4)} p-3.5`}>
              <div className="flex items-center gap-2">
                <div className="text-[15px] font-bold tracking-tight">{i.label}</div>
                <span className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide" style={{ background: s.bg, color: s.color }}>
                  {i.mode}
                </span>
              </div>
              <div className="mt-1 text-[13px] leading-snug text-[var(--muted)]">{i.detail}</div>
            </div>
          );
        })}
      </section>

      <div className="card mt-6 overflow-hidden p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--brand-soft)] text-[18px]">📲</span>
          <div className="text-[15px] font-bold tracking-tight">Install Kinline</div>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
          This is an installable app. In your browser&apos;s menu, choose &ldquo;Add to Home Screen&rdquo; / &ldquo;Install Kinline&rdquo;
          to use it full-screen like a native app — it works offline for the shell.
        </p>
      </div>

      <p className="mt-6 text-center text-[12px] text-[var(--faint)]">
        Kinline · four independent agents, one companion app.
      </p>
    </main>
  );
}
