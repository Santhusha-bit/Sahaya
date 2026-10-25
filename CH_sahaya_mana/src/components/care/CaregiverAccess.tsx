"use client";

import { useCallback, useEffect, useState } from "react";

type Grant = {
  caregiverId: string;
  scopes: string[];
  canApprove: boolean;
  grantedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  recipientLabel: string | null;
  active: boolean;
};
type Overview = { myId: string | null; grants: Grant[]; audit: Array<{ at: number; message: string; caregiver: string | null }> };

const SCOPES: Array<{ id: string; label: string }> = [
  { id: "care:medications", label: "See medications" },
  { id: "care:medications:approve", label: "Approve refills and medication changes" },
  { id: "care:grocery", label: "See groceries, pantry and meals" },
  { id: "care:grocery:approve", label: "Approve grocery orders" },
  { id: "care:home-services", label: "See home repair bookings" },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label]));

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
const shortId = (id: string) => (id.length > 28 ? `…${id.slice(-24)}` : id);

/**
 * The person's own control over caregiver access (Care page). Grants are by the caregiver's Sahaya ID (shown on
 * the caregiver's Profile page), capability by capability, optionally time-limited, and revocable at any time.
 * Everything is enforced on the server; this is only the control surface.
 */
export function CaregiverAccess() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caregiverId, setCaregiverId] = useState("");
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["care:grocery"]);
  const [days, setDays] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/care/caregivers", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Couldn't load caregiver access.");
        return;
      }
      setError(null);
      setData(json);
    } catch {
      setError("Couldn't reach Sahaya. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/care/caregivers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "That didn't work.");
      else {
        setStatus(done);
        await load();
      }
    } catch {
      setError("Couldn't reach Sahaya. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setScopes((cur) => {
      // Removing a view permission also removes the matching approve permission.
      if (cur.includes(id)) return cur.filter((s) => s !== id && s !== `${id}:approve`);
      const next = [...cur, id];
      // Approving needs the matching view permission.
      if (id.endsWith(":approve")) next.push(id.replace(/:approve$/, ""));
      return [...new Set(next)];
    });

  if (!data && !error) return <p className="px-5 py-3 text-lg text-ink-muted" role="status">Loading caregiver access…</p>;
  if (!data) return <p role="alert" className="mx-5 my-3 rounded-2xl border-2 border-line p-4 text-lg text-ink-muted">{error}</p>;
  if (!data.myId) {
    return (
      <p className="mx-5 my-3 rounded-2xl border-2 border-dashed border-line p-4 text-lg text-ink-muted">
        Sharing with caregivers needs sign-in, so each person is who they say they are. It isn&apos;t available in local test mode.
      </p>
    );
  }
  const active = data.grants.filter((g) => g.active);
  return (
    <section className="px-5 py-4" aria-labelledby="caregivers-h">
      <h2 id="caregivers-h" className="text-2xl font-bold text-care">Who can help with Care</h2>
      <p className="mt-1 text-lg text-ink-muted">
        You decide who sees what. A caregiver gives you their Sahaya ID from their own Profile page. You can remove access at any time.
      </p>
      {active.length === 0 ? (
        <p className="mt-3 rounded-2xl border-2 border-dashed border-line p-4 text-lg text-ink-muted">Nobody has access right now.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {active.map((g) => (
            <li key={g.caregiverId} className="rounded-2xl border-2 border-line bg-surface p-4">
              <p className="break-all font-mono text-base">{shortId(g.caregiverId)}</p>
              <p className="text-base">{g.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(" · ")}</p>
              <p className="text-base text-ink-muted">
                Since {fmtDate(g.grantedAt)}
                {g.expiresAt ? ` · ends ${fmtDate(g.expiresAt)}` : ""}
              </p>
              <button
                disabled={busy}
                onClick={() => send({ caregiverId: g.caregiverId, revoke: true }, "Access removed.")}
                className="mt-2 min-h-12 rounded-full border-2 border-line px-5 text-lg font-bold disabled:opacity-40"
              >
                Remove access
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-4 grid gap-3 rounded-2xl border-2 border-line bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(
            {
              caregiverId: caregiverId.trim(),
              scopes,
              canApprove: scopes.some((s) => s.endsWith(":approve")),
              ...(days ? { expiresInDays: Number(days) } : {}),
              ...(label.trim() ? { recipientLabel: label.trim() } : {}),
            },
            "Access shared.",
          ).then(() => setCaregiverId(""));
        }}
      >
        <label className="grid gap-1 text-lg font-bold">
          Caregiver&apos;s Sahaya ID
          <input value={caregiverId} onChange={(e) => setCaregiverId(e.target.value)} required minLength={3} className="min-h-12 rounded-xl border-2 border-line px-3 font-mono text-base font-normal" />
        </label>
        <fieldset className="grid gap-1">
          <legend className="text-lg font-bold">What they may do</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex min-h-12 items-center gap-3 text-lg">
              <input type="checkbox" className="h-6 w-6" checked={scopes.includes(s.id)} onChange={() => toggle(s.id)} />
              {s.label}
            </label>
          ))}
        </fieldset>
        <label className="grid gap-1 text-lg font-bold">
          For how long
          <select value={days} onChange={(e) => setDays(e.target.value)} className="min-h-12 rounded-xl border-2 border-line px-3 text-lg font-normal">
            <option value="">Until I remove it</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </label>
        <label className="grid gap-1 text-lg font-bold">
          How they&apos;ll see you (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="e.g. Mum" className="min-h-12 rounded-xl border-2 border-line px-3 text-lg font-normal" />
        </label>
        <button type="submit" disabled={busy || !caregiverId.trim() || !scopes.length} className="min-h-12 rounded-full bg-care px-5 text-lg font-bold text-white disabled:opacity-40">
          Share access
        </button>
      </form>
      <p aria-live="polite" className="mt-2 text-lg">{status}</p>
      {error && <p role="alert" className="mt-2 text-lg text-warn">{error}</p>}

      {data.audit.length > 0 && (
        <details className="mt-4">
          <summary className="min-h-12 cursor-pointer text-lg font-bold">Recent caregiver activity</summary>
          <ul className="mt-2 grid gap-1 text-base">
            {data.audit.map((a, i) => (
              <li key={i}>
                {new Date(a.at).toLocaleString()} — {a.message}
                {a.caregiver ? ` (${shortId(a.caregiver)})` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
