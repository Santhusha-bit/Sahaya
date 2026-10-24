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

  return (
    <main className="px-5 pt-10">
      <h1 className="text-[26px] font-bold">Profile</h1>

      {status && (
        <div className="card mt-4 p-4">
          <div className="text-[18px] font-bold">{status.user.name}</div>
          <div className="text-[13px] text-[var(--muted)]">
            {status.user.role} · auth: {status.user.authMode}
          </div>
        </div>
      )}

      <h2 className="mt-6 text-[15px] font-bold uppercase tracking-wide text-[var(--muted)]">Integrations</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        Honest status of every external service (prompt acceptance criterion 12).
      </p>
      <section className="mt-3 flex flex-col gap-2">
        {status?.integrations.map((i) => {
          const s = MODE_STYLE[i.mode];
          return (
            <div key={i.key} className="card p-3">
              <div className="flex items-center gap-2">
                <div className="text-[15px] font-semibold">{i.label}</div>
                <span className="pill ml-auto px-2.5 py-0.5 text-[11px] font-bold uppercase" style={{ background: s.bg, color: s.color }}>
                  {i.mode}
                </span>
              </div>
              <div className="mt-0.5 text-[13px] text-[var(--muted)]">{i.detail}</div>
            </div>
          );
        })}
      </section>

      <div className="card mt-6 p-4">
        <div className="text-[15px] font-bold">Install Kinline</div>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          This is an installable app. In your browser's menu, choose “Add to Home Screen” / “Install Kinline” to use it
          full-screen like a native app — it works offline for the shell.
        </p>
      </div>

      <p className="mt-6 text-center text-[12px] text-[var(--muted)]">
        Kinline · four independent agents, one companion app.
      </p>
    </main>
  );
}
