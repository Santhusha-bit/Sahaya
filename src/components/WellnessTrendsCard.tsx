"use client";

import { useCallback, useEffect, useState } from "react";

/** ---- Types mirrored from GET /api/wellness/trends ---- */
interface Bucket {
  bucketStart: number;
  label: string;
  count: number;
  average: number;
  min: number;
  max: number;
  stddev: number | null;
  insufficient: boolean;
}
interface Evidence {
  observationId: string;
  observedAt: number;
  value: number;
  unit: string;
  source: string;
  corrected: boolean;
  quote?: string;
}
interface Trend {
  metric: "sleep" | "energy";
  label: string;
  unit: string;
  granularity: "weekly" | "monthly";
  mode: "live" | "sandbox" | "unavailable";
  buckets: Bucket[];
  current: Bucket | null;
  currentIsStale: boolean;
  baseline: { average: number | null; stddev: number | null; count: number; periods: number };
  comparison: { delta: number | null; direction: "lower" | "higher" | "similar" | "insufficient" };
  uncertainty: { confidence: "low" | "medium" | "high"; margin: number | null; reasons: string[] };
  evidence: Evidence[];
  totalObservations: number;
  narrative: string;
  lastSync: { ranAt: number; ok: boolean; status: string } | null;
  error?: string;
}
interface TrendsResponse {
  sleep?: Trend;
  energy?: Trend;
  hidden?: boolean;
  disabled?: boolean;
  reason?: string;
  integration: { mode: string; detail: string };
}

const ACCENT = "#c98a2e";
const ACCENT_DARK = "#8a5a14";
const ACCENT_SOFT = "#fbf0dc";

const MODE_STYLE: Record<string, { bg: string; color: string }> = {
  live: { bg: "#d1fae5", color: "#065f46" },
  sandbox: { bg: "#fef3c7", color: "#92400e" },
  unavailable: { bg: "#fee2e2", color: "#991b1b" },
};
const CONFIDENCE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  high: { bg: "#d1fae5", color: "#065f46", label: "High confidence" },
  medium: { bg: "#e0e7ff", color: "#3730a3", label: "Medium confidence" },
  low: { bg: "#f3f4f6", color: "#374151", label: "Low confidence" },
};
const DIRECTION_TEXT: Record<string, string> = {
  lower: "below usual",
  higher: "above usual",
  similar: "about usual",
  insufficient: "no baseline yet",
};

function fmtValue(metric: Trend["metric"], v: number): string {
  return metric === "sleep" ? `${Math.round(v * 10) / 10}h` : `${Math.round(v * 10) / 10}/5`;
}
function fmtDay(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
function fmtAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}
/** 95% margin on a bucket's average from its own spread (null when it can't be estimated). */
function bucketMargin(b: Bucket): number | null {
  return b.stddev !== null && b.count > 1 ? (1.96 * b.stddev) / Math.sqrt(b.count) : null;
}

/** Bars of period averages with 95% whiskers and a dashed "usual" reference line. */
function TrendChart({ trend }: { trend: Trend }) {
  const [hover, setHover] = useState<number | null>(null);
  const buckets = trend.buckets;
  if (!buckets.length) return null;

  const W = 320, H = 150, padL = 30, padR = 8, padT = 12, padB = 26;
  const yMax = trend.metric === "sleep" ? Math.max(9, ...buckets.map((b) => b.average + (bucketMargin(b) ?? 0))) : 5;
  const y = (v: number) => padT + (H - padT - padB) * (1 - Math.min(v, yMax) / yMax);
  const slot = (W - padL - padR) / buckets.length;
  const barW = Math.min(28, slot * 0.6);
  const ticks = trend.metric === "sleep" ? [0, 3, 6, 9].filter((t) => t <= yMax) : [1, 3, 5];
  const base = trend.baseline.average;
  const hovered = hover !== null ? buckets[hover] : null;

  return (
    <div className="relative mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${trend.label} ${trend.granularity} averages`}>
        <defs>
          <pattern id={`hatch-${trend.metric}`} width="5" height="5" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="5" stroke={ACCENT} strokeWidth="1.5" strokeOpacity="0.55" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#eceef3" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="#8b90a0">{t}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = padL + slot * i + slot / 2;
          const top = y(b.average);
          const bottom = y(0);
          const h = Math.max(bottom - top, 2);
          const isCurrent = trend.current?.bucketStart === b.bucketStart;
          const m = bucketMargin(b);
          const r = Math.min(4, barW / 2, h);
          // Rounded data-end on top, square on the baseline.
          const path = `M ${cx - barW / 2} ${bottom} V ${top + r} Q ${cx - barW / 2} ${top} ${cx - barW / 2 + r} ${top} H ${cx + barW / 2 - r} Q ${cx + barW / 2} ${top} ${cx + barW / 2} ${top + r} V ${bottom} Z`;
          return (
            <g key={b.bucketStart} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${b.label}: ${fmtValue(trend.metric, b.average)} from ${b.count} reports`}>
              <rect x={padL + slot * i} y={padT} width={slot} height={H - padT - padB} fill="transparent" />
              <path d={path} fill={b.insufficient ? `url(#hatch-${trend.metric})` : isCurrent ? ACCENT_DARK : ACCENT} stroke={b.insufficient ? ACCENT : "none"} strokeWidth={b.insufficient ? 1 : 0} opacity={hover === null || hover === i ? 1 : 0.55} />
              {m !== null && (
                <g stroke="#3b3f4c" strokeWidth={1.5} strokeLinecap="round">
                  <line x1={cx} x2={cx} y1={y(b.average + m)} y2={y(Math.max(b.average - m, 0))} />
                  <line x1={cx - 4} x2={cx + 4} y1={y(b.average + m)} y2={y(b.average + m)} />
                  <line x1={cx - 4} x2={cx + 4} y1={y(Math.max(b.average - m, 0))} y2={y(Math.max(b.average - m, 0))} />
                </g>
              )}
              <text x={cx} y={H - padB + 13} textAnchor="middle" fontSize="9.5" fill={isCurrent ? "#1f2330" : "#8b90a0"} fontWeight={isCurrent ? 700 : 400}>
                {trend.granularity === "weekly" ? b.label.replace("Week of ", "") : b.label.slice(0, 3)}
              </text>
            </g>
          );
        })}
        {base !== null && (
          <g>
            <line x1={padL} x2={W - padR} y1={y(base)} y2={y(base)} stroke="#3b3f4c" strokeWidth={1.5} strokeDasharray="4 3" />
            <text x={W - padR} y={y(base) - 4} textAnchor="end" fontSize="10" fill="#3b3f4c">usual {fmtValue(trend.metric, base)}</text>
          </g>
        )}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-[12px] shadow-lg">
          <div className="font-bold">{hovered.label}</div>
          <div>Average {fmtValue(trend.metric, hovered.average)} from {hovered.count} report{hovered.count === 1 ? "" : "s"}</div>
          <div className="text-[var(--muted)]">Range {fmtValue(trend.metric, hovered.min)} to {fmtValue(trend.metric, hovered.max)}{bucketMargin(hovered) !== null ? `, ±${fmtValue(trend.metric, bucketMargin(hovered)!)}` : ""}</div>
          {hovered.insufficient && <div className="text-amber-700">Too few reports to rely on alone</div>}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
        <span>Whiskers: 95% range for the average</span>
        <span>Hatched: fewer than {trend.granularity === "weekly" ? 3 : 7} reports</span>
        <span>Missing {trend.granularity === "weekly" ? "weeks" : "months"} are left out, never counted as zero</span>
      </div>
    </div>
  );
}

export function WellnessTrendsCard({ audience, refreshToken, onChange }: { audience: "self" | "family"; refreshToken?: string; onChange?: () => void }) {
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [metric, setMetric] = useState<"sleep" | "energy">("sleep");
  const [granularity, setGranularity] = useState<"weekly" | "monthly">("weekly");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/wellness/trends?audience=${audience}&granularity=${granularity}`);
    const json = (await res.json()) as TrendsResponse;
    setData(json);
    return json;
  }, [audience, granularity]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, refreshToken]);

  const post = useCallback(
    async (body: Record<string, unknown>, describe: (t: Trend | undefined) => string) => {
      setBusy(true);
      setNotice(null);
      try {
        await fetch("/api/wellness/trends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const fresh = await load();
        setNotice(describe(fresh.sleep));
        onChange?.();
      } finally {
        setBusy(false);
      }
    },
    [load, onChange],
  );

  if (!data) return <div className="card mt-2 p-4"><div className="skeleton h-4 w-2/5" /><div className="skeleton mt-3 h-24 w-full" /></div>;
  if (data.hidden || data.disabled) {
    return <div className="card mt-2 p-4 text-[13px] text-[var(--faint)]">🔒 {data.reason}</div>;
  }

  const trend = metric === "sleep" ? data.sleep! : data.energy!;
  const mode = MODE_STYLE[trend.mode] ?? MODE_STYLE.sandbox;
  const conf = CONFIDENCE_STYLE[trend.uncertainty.confidence];
  const segBtn = (active: boolean) =>
    active ? { background: ACCENT, color: "#fff" } : { background: "#fff", color: "var(--muted)", border: "1px solid var(--line)" };

  return (
    <div className="card mt-2 p-4">
      {/* Controls in one row above the chart */}
      <div className="flex flex-wrap items-center gap-2">
        {(["sleep", "energy"] as const).map((m) => (
          <button key={m} onClick={() => setMetric(m)} className="btn pill px-3 py-1 text-[12px] font-semibold capitalize" style={segBtn(metric === m)}>{m}</button>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--line)]" />
        {(["weekly", "monthly"] as const).map((g) => (
          <button key={g} onClick={() => setGranularity(g)} className="btn pill px-3 py-1 text-[12px] font-semibold capitalize" style={segBtn(granularity === g)}>{g}</button>
        ))}
        <span className="pill ml-auto px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: mode.bg, color: mode.color }} title={data.integration.detail}>
          Tiger Data · {trend.mode}
        </span>
      </div>

      {/* Headline */}
      {trend.current ? (
        <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
          <div className="text-[30px] font-extrabold leading-none tracking-tight">{fmtValue(metric, trend.current.average)}</div>
          <div className="pb-0.5 text-[13px] text-[var(--muted)]">
            {trend.currentIsStale ? trend.current.label : granularity === "weekly" ? "this week" : "this month"} · {trend.current.count} report{trend.current.count === 1 ? "" : "s"}
            {trend.uncertainty.margin !== null ? ` · ±${fmtValue(metric, trend.uncertainty.margin)}` : ""}
          </div>
          <div className="flex gap-1.5 pb-0.5">
            <span className="pill px-2 py-0.5 text-[11px] font-semibold" style={{ background: ACCENT_SOFT, color: ACCENT_DARK }}>
              {DIRECTION_TEXT[trend.comparison.direction]}
              {trend.comparison.delta !== null && trend.comparison.direction !== "insufficient" ? ` (${trend.comparison.delta > 0 ? "+" : ""}${fmtValue(metric, trend.comparison.delta)})` : ""}
            </span>
            <span className="pill px-2 py-0.5 text-[11px] font-semibold" style={{ background: conf.bg, color: conf.color }}>{conf.label}</span>
          </div>
        </div>
      ) : null}

      <TrendChart trend={trend} />

      <p className="mt-3 text-[14px] leading-relaxed">{trend.narrative}</p>

      {trend.uncertainty.reasons.length > 0 && (
        <details className="mt-2 text-[12px] text-[var(--muted)]">
          <summary className="cursor-pointer font-semibold">How sure is this?</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {trend.uncertainty.reasons.map((r, i) => <li key={i}>• {r}</li>)}
            {trend.baseline.average !== null && (
              <li>• Usual level is the person&apos;s own average over {trend.baseline.count} earlier report{trend.baseline.count === 1 ? "" : "s"}, not a population norm.</li>
            )}
          </ul>
        </details>
      )}

      {trend.evidence.length > 0 && (
        <details className="mt-2 text-[12px]" open={audience === "self"}>
          <summary className="cursor-pointer font-semibold text-[var(--muted)]">Evidence behind {trend.currentIsStale ? "this period" : granularity === "weekly" ? "this week" : "this month"} ({trend.evidence.length})</summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {trend.evidence.map((e) => (
              <li key={e.observationId} className="rounded-xl border border-[var(--line)] px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{fmtValue(metric, e.value)}</span>
                  <span className="text-[var(--faint)]">{fmtDay(e.observedAt)} · {e.source.replace("_", " ")}</span>
                  {e.corrected && <span className="pill bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">corrected</span>}
                </div>
                {e.quote && <div className="mt-0.5 italic text-[var(--muted)]">“{e.quote}”</div>}
              </li>
            ))}
          </ul>
          {audience === "family" && !trend.evidence.some((e) => e.quote) && (
            <p className="mt-1 text-[11px] text-[var(--faint)]">Source sentences are private unless raw-conversation sharing is turned on.</p>
          )}
        </details>
      )}

      {audience === "self" && (
        <div className="mt-3 border-t border-[var(--line)] pt-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              const said = text.trim();
              setText("");
              post({ action: "converse", text: said }, (t) =>
                t?.current ? `Trend updated: ${t.current.label.toLowerCase()} is now ${fmtValue("sleep", t.current.average)} across ${t.current.count} report${t.current.count === 1 ? "" : "s"}.` : "Saved. No sleep hours were found in that message.",
              );
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Tell Wellness how you slept"
              placeholder="e.g. I only slept about four hours last night"
              className="h-10 flex-1 rounded-xl border border-[var(--line)] px-3 text-[14px] outline-none"
            />
            <button disabled={busy} className="btn rounded-xl px-3 py-2 text-[13px] font-semibold text-white" style={{ background: ACCENT }}>Tell</button>
          </form>
          {trend.totalObservations < 6 && (
            <button
              disabled={busy}
              onClick={() => post({ action: "seedDemo" }, (t) => `Loaded fictional demo history: ${t?.buckets.length ?? 0} weeks of sleep reports.`)}
              className="btn mt-2 rounded-xl bg-[var(--bg-tint)] px-3 py-1.5 text-[12px] font-semibold text-[var(--muted)]"
            >
              Load 4-week demo history (fictional)
            </button>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--faint)]" aria-live="polite">
        <span>{notice ?? (trend.lastSync ? `Synced from Convex ${fmtAgo(trend.lastSync.ranAt)}${trend.lastSync.ok ? "" : " (last sync failed)"}` : "Not synced yet")}</span>
        <span>Self-reported · not medical advice</span>
      </div>
    </div>
  );
}
