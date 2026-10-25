"use client";

import { useState } from "react";
import { Card } from "@/components/ui";

/* Shapes returned by GET /api/care/dashboard → homeServices. */
type Service = "plumbing" | "electrical" | "handyman" | "appliance" | "hvac" | "tech" | "cleaning" | "chores";
interface Window { windowId: string; label: string }
export interface BookingCard { bookingId: string; title: string; service: Service; issue: string; provider: string; arrivalWindow: string; reference: string; status: string; statusCode: "booked" | "on_the_way" | "done"; estimate: string }
export interface HomeRepairOwnerView {
  pending: { proposalId: string; requestId: string; approvalId: string | null; service: Service; issue: string; time: string; provider: string; cost: string } | null;
  openRequest: { requestId: string; service: Service; issue: string; safety: { emergency: boolean; steps: string[] }; timeWindows: Window[] } | null;
  changeTimes: Window[];
  bookings: BookingCard[];
  audit: Array<{ at: number; message: string }>;
}
export interface HomeRepairCaregiverView { bookings: BookingCard[] }

const SERVICE_NAME: Record<Service, string> = {
  plumbing: "Plumbing",
  electrical: "Electrical",
  handyman: "Handyman",
  appliance: "Appliance repair",
  hvac: "Heating and cooling",
  tech: "Tech help",
  cleaning: "Cleaning",
  chores: "Chores",
};
const STEPS: Array<BookingCard["statusCode"]> = ["booked", "on_the_way", "done"];
const STEP_LABEL: Record<BookingCard["statusCode"], string> = { booked: "Booked", on_the_way: "On the way", done: "Done" };
const inputCls = "min-h-12 w-full rounded-xl border-2 border-line bg-surface px-3 text-lg";
const primary = "min-h-12 rounded-full bg-care px-5 text-lg font-bold text-white disabled:opacity-40";
const secondary = "min-h-12 rounded-full border-2 border-line bg-surface px-5 text-lg font-bold disabled:opacity-40";

/** Booking confirmation card — "Plumber booked" with provider, arrival window, reference and status. */
export function BookingConfirmation({ b }: { b: BookingCard }) {
  const at = STEPS.indexOf(b.statusCode);
  return (
    <Card className="border-l-8 border-care">
      <p className="text-xl font-bold">{b.title}</p>
      <p className="mt-1 text-lg">{b.issue}</p>
      <dl className="mt-2 grid gap-1 text-lg">
        <div><dt className="inline font-bold">Provider: </dt><dd className="inline">{b.provider}</dd></div>
        <div><dt className="inline font-bold">Arrival window: </dt><dd className="inline">{b.arrivalWindow}</dd></div>
        <div><dt className="inline font-bold">Reference: </dt><dd className="inline">{b.reference}</dd></div>
        <div><dt className="inline font-bold">Estimated cost: </dt><dd className="inline">{b.estimate}</dd></div>
      </dl>
      <ol className="mt-3 flex flex-wrap gap-2" aria-label="Status">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === at ? "step" : undefined} className={`rounded-full px-3 py-1 text-base font-bold ${i <= at ? "bg-care-soft text-ok" : "bg-canvas text-ink-muted"}`}>
            {STEP_LABEL[s]}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * Home repairs on the Care page: describe the problem → safety steps → pick a time → approval card
 * (Approve / Change time / Decline) → after Approve only, the booking confirmation. All checks are on the server.
 */
export function HomeRepairHelp({ view, onChanged }: { view: HomeRepairOwnerView; onChanged: () => Promise<void> }) {
  const [service, setService] = useState<Service>("plumbing");
  const [description, setDescription] = useState("");
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/care/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ as: "self", ...body }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? "That didn't work. Please try again.");
    return json;
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally {
      await onChanged();
      setBusy(false);
    }
  }

  const start = () => run(async () => {
    await post({ action: "home_start", service, description });
    setDescription("");
  });
  const choose = (requestId: string, windowId: string) => run(async () => {
    await post({ action: "home_choose_time", requestId, windowId });
    setChanging(false);
  });
  const decide = (approvalId: string, decision: "approve" | "deny") => run(async () => {
    const out = await post({ action: "decide", approvalId, decision });
    const r = out.result as { status: string; error?: string } | undefined;
    if (decision === "approve" && r?.status === "error") throw new Error(r.error ?? "That couldn't be booked. Please try again.");
  });

  const p = view.pending;
  const open = view.openRequest;

  return (
    <div className="flex flex-col gap-3" data-testid="home-repairs">
      {!p && !open && (
        <Card>
          <p className="text-lg font-bold">Need something fixed at home?</p>
          <p className="text-lg text-ink-muted">Tell me what&apos;s wrong and I&apos;ll arrange someone to come.</p>
          <div className="mt-2 grid gap-3">
            <label className="grid gap-1 text-lg">
              What kind of help
              <select className={inputCls} value={service} onChange={(e) => setService(e.target.value as Service)}>
                {(Object.keys(SERVICE_NAME) as Service[]).map((k) => <option key={k} value={k}>{SERVICE_NAME[k]}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-lg">
              What&apos;s wrong
              <input className={inputCls} value={description} maxLength={300} placeholder="For example: the kitchen sink is leaking" onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
          <div className="mt-3"><button className={primary} disabled={busy || description.trim().length < 3} onClick={start}>Get help</button></div>
        </Card>
      )}

      {open && !p && (
        <Card>
          {open.safety.steps.length > 0 && (
            <div className={`rounded-2xl p-3 ${open.safety.emergency ? "bg-[#fde8e6]" : "bg-canvas"}`} role={open.safety.emergency ? "alert" : undefined}>
              <p className="text-lg font-bold">{open.safety.emergency ? "Do this first" : "While you wait"}</p>
              <ul className="mt-1 list-disc pl-6 text-lg">{open.safety.steps.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          <p className="mt-3 text-lg">I can arrange this for you. Which time suits you?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {open.timeWindows.map((w) => <button key={w.windowId} className={secondary} disabled={busy} onClick={() => choose(open.requestId, w.windowId)}>{w.label}</button>)}
          </div>
        </Card>
      )}

      {p && (
        <Card className="border-l-8 border-[#9a6400]">
          <p className="text-base font-bold uppercase tracking-wide text-warn">Please approve</p>
          <dl className="mt-2 grid gap-1 text-lg" data-testid="approval-card">
            <div><dt className="inline font-bold">Service: </dt><dd className="inline">{SERVICE_NAME[p.service]}</dd></div>
            <div><dt className="inline font-bold">Issue: </dt><dd className="inline">{p.issue}</dd></div>
            <div><dt className="inline font-bold">Time: </dt><dd className="inline">{p.time}</dd></div>
            <div><dt className="inline font-bold">Provider: </dt><dd className="inline">{p.provider}</dd></div>
            <div><dt className="inline font-bold">Estimated cost: </dt><dd className="inline">{p.cost}</dd></div>
          </dl>
          {p.approvalId && !changing && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={primary} disabled={busy} onClick={() => decide(p.approvalId!, "approve")}>Approve</button>
              <button className={secondary} disabled={busy} onClick={() => setChanging(true)}>Change time</button>
              <button className={secondary} disabled={busy} onClick={() => decide(p.approvalId!, "deny")}>Decline</button>
            </div>
          )}
          {changing && (
            <div className="mt-3">
              <p className="text-lg font-bold">Pick another time</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.changeTimes.map((w) => <button key={w.windowId} className={secondary} disabled={busy} onClick={() => choose(p.requestId, w.windowId)}>{w.label}</button>)}
                <button className={secondary} disabled={busy} onClick={() => setChanging(false)}>Keep {p.time}</button>
              </div>
            </div>
          )}
        </Card>
      )}

      {problem && <p role="alert" className="rounded-2xl bg-[#fde8e6] p-3 text-lg text-danger">{problem}</p>}

      {view.bookings.map((b) => <BookingConfirmation key={b.bookingId} b={b} />)}

      {view.audit.length > 0 && (
        <details className="rounded-[var(--radius-card)] bg-surface p-4 shadow-sm">
          <summary className="min-h-12 cursor-pointer text-lg font-bold text-care">History ({view.audit.length})</summary>
          <ul className="mt-1 text-base">{view.audit.map((a, i) => <li key={`${a.at}-${i}`}>{new Date(a.at).toLocaleString()} — {a.message}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
