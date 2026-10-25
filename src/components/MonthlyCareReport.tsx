"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FamilyCareReport } from "@/analytics/familyCareReport";

function recentPeriods(n: number): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push({
      value: m.toISOString().slice(0, 7),
      label: m.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    });
  }
  return out;
}

const SHARING: { key: string; label: string }[] = [
  { key: "householdAnalyticsMedication", label: "Medication totals" },
  { key: "householdAnalyticsAssistance", label: "Help-request totals" },
];

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}>
      <div className="text-[12px] font-semibold text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-[22px] font-extrabold tracking-tight">{value}</div>
      {note ? <div className="mt-0.5 text-[12px] text-[var(--muted)]">{note}</div> : null}
    </div>
  );
}

/** Monthly family care summary, read from household analytics (Snowflake). */
export function MonthlyCareReport() {
  const periods = useMemo(() => recentPeriods(6), []);
  const [period, setPeriod] = useState(periods[0].value);
  const [report, setReport] = useState<FamilyCareReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [consent, setConsent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/consent")
      .then((r) => r.json())
      .then((d: { consent: Record<string, boolean> }) => setConsent(d.consent))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (method: "GET" | "POST") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        method === "GET" ? `/api/household/report?period=${period}` : "/api/household/report",
        method === "GET"
          ? undefined
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period }) },
      );
      const body = (await res.json()) as { ok: boolean; report?: FamilyCareReport; error?: string };
      if (body.ok && body.report) setReport(body.report);
      else setError(body.error ?? "Could not load the report.");
    } catch {
      setError("Could not load the report.");
    } finally {
      setBusy(false);
    }
  }, [period]);

  useEffect(() => {
    void load("GET");
  }, [load]);

  // Changing what is shared re-runs the export, so revoked totals are withdrawn.
  const toggleSharing = useCallback(
    async (key: string, value: boolean) => {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const d = (await res.json()) as { consent: Record<string, boolean> };
      setConsent(d.consent);
      await load("POST");
    },
    [load],
  );

  const med = report?.medication;
  const assist = report?.assistance;
  const medTrend =
    med?.rate != null && med.previousRate != null
      ? Math.round(med.rate * 100) === Math.round(med.previousRate * 100)
        ? "Same as last month"
        : `${med.rate > med.previousRate ? "▲ Up" : "▼ Down"} from ${Math.round(med.previousRate * 100)}%`
      : undefined;

  return (
    <section className="card fade-up mt-5 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-[16px] font-bold tracking-tight">Monthly care summary</h2>
        {report ? (
          <span className="pill ml-auto px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]" style={{ border: "1px solid var(--line)" }}>
            {report.source === "snowflake" ? "Snowflake · live" : "Sandbox"}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex gap-2">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="min-w-0 flex-1 rounded-xl px-3 py-2 text-[14px]"
          style={{ background: "#fff", border: "1px solid var(--line)" }}
          aria-label="Month"
        >
          {periods.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <button
          onClick={() => load("POST")}
          disabled={busy}
          className="btn pill shrink-0 px-3.5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-brand)" }}
        >
          {busy ? "Generating…" : "Generate"}
        </button>
      </div>

      {error ? <p className="mt-3 text-[13px] text-[var(--muted)]">{error}</p> : null}

      {report ? (
        <>
          <p className="mt-3 text-[15px] font-semibold">{report.headline}</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Tile
              label="Meds taken"
              value={med?.rate != null ? `${Math.round(med.rate * 100)}%` : "–"}
              note={med ? medTrend ?? `${med.taken} of ${med.taken + med.skipped}` : "Not shared"}
            />
            <Tile
              label="Help requests"
              value={assist ? `${assist.completed}/${assist.total}` : "–"}
              note={assist ? (assist.open ? `${assist.open} still open` : "completed") : "Not shared"}
            />
            <Tile label="Check-ins" value={report.wellness ? String(report.wellness.checkins) : "–"} note={report.wellness ? "this month" : "None yet"} />
          </div>
          {report.lines.length ? (
            <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-[13px] text-[var(--muted)]">
              {report.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
          {report.notShared.length ? (
            <p className="mt-3 text-[12px] text-[var(--faint)]">🔒 Not shared by Eleanor&apos;s choice: {report.notShared.join(", ")}.</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {SHARING.map((s) => {
              const on = consent[s.key] !== false;
              return (
                <button
                  key={s.key}
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleSharing(s.key, !on)}
                  disabled={busy}
                  className="btn pill px-3 py-1 text-[12px] font-semibold"
                  style={{ background: "#fff", border: "1px solid var(--line)", color: on ? "var(--ink)" : "var(--faint)" }}
                >
                  {on ? "✓" : "🔒"} {s.label} {on ? "shared" : "not shared"}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] text-[var(--faint)]">
            Totals only. No medication names, notes or messages leave Kinline.
          </p>
        </>
      ) : null}
    </section>
  );
}
