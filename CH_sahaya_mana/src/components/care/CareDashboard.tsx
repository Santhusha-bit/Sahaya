"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVoiceStatus, installAudioUnlock, speak, type SpeakHandle, type SpeechProvider, type VoiceStatusInfo } from "@/components/voice/speech";
import { Card, EmptyState, ModeBadge, Section } from "@/components/ui";
import { BookingConfirmation, HomeRepairHelp, type HomeRepairCaregiverView, type HomeRepairOwnerView } from "@/components/care/HomeRepairHelp";
import type { IntegrationMode } from "@/integrations/status";

/* Shapes returned by GET /api/care/dashboard (server-filtered by permission). */
type Denied = { denied: true; reason: string };
interface Dose { doseId: string; slot: string; time: string; state: string; late: boolean; confirmedAt: string | null; canConfirm: boolean }
interface MedToday { medicationId: string; name: string; doseText: string; pillsRemaining: number | null; daysOfSupply: number | null; refillLeadDays: number; doses: Dose[] }
interface MemoryItem { id: string; kind: string; label: string; value: string; status: "confirmed" | "reported" | "inferred"; safetyCritical: boolean; via: string; evidence: number | null }
interface Refill { refillId: string; medication: string; quantity: number | null; pharmacy: string | null; status: string; missing: string[]; simulated: boolean; updated: string; pharmacyMessages: Array<{ text: string; flagged: boolean }> }
interface Medication { today: MedToday[]; adherence: { total: number; onTime: number; late: number; missed: number }; recent: Array<{ doseId: string; when: string; medication: string; state: string; late: boolean }>; refills: Refill[] }
interface Grocery {
  preferences: { allergies: string[]; preferredTags: string[]; notes: string[]; essentials: string[]; limits: { perOrder: string; weekly: string } } | null;
  cart: { cartId: string; lines: Array<{ name: string; quantity: number; price: string; substitutedFor: string | null }>; pendingSubstitutions: Array<{ id: string; original: { name: string }; substitute: { name: string }; reason: string }>; pendingAdditions: Array<{ id: string; name: string; reason: string }>; blocked: Array<{ name: string; reasons: string[] }>; total: string; deliveryWindow: string | null } | null;
  orders: Array<{ orderId: string; status: string; total: string; window: string; items: number; simulated: boolean; confirmation: string | null }>;
}
interface Meals {
  pantry: Array<{ name: string; quantity: number; unit: string; expiresOn: string | null; allergenInfo: string }>;
  expiringSoon: Array<{ name: string; expiresOn: string; expired: boolean }>;
  plan: { ideas: Array<{ recipeId: string; name: string; minutes: number; uses: string[]; usesExpiring: string[]; missing: string[] }>; excluded: Array<{ name: string; reasons: string[] }> } | null;
  cooking: { recipe: string; step: number; totalSteps: number; status: string; say: string | null } | null;
}
interface Dashboard {
  viewer: { role: string; id: string };
  viewerLabel: string;
  demoMode: boolean;
  profileMode: "real" | "demo" | "test";
  identityKind: "user" | "local";
  storage: string;
  memory: MemoryItem[];
  profile: { displayName: string; isDemo: boolean; timeZone: string } | null;
  clock: { now: number; local: string };
  sandboxClock: { simulatedOffsetMinutes: number };
  access: { medications: boolean; grocery: boolean; approveMedications: boolean; approveGrocery: boolean };
  medication: Medication | Denied;
  grocery: Grocery | Denied;
  meals: Meals | Denied;
  homeServices: HomeRepairOwnerView | HomeRepairCaregiverView | Denied;
  support: {
    alerts: Array<{ id: string; kind: string; area: string; severity: string; title: string; detail: string; when: string; acknowledgedAt?: number; acknowledgedBy?: string; escalationStatus?: string }>;
    approvals: Array<{ id: string; toolName: string; summary: string; area: string; expires: string; canDecide: boolean; userOnly: boolean }>;
    helpRequests: Array<{ id: string; need: string; summary: string; status: string }>;
  };
  voice: Array<{ id: string; at: string; purpose: string; direction: string; text: string; simulated: boolean; channelMode: string }>;
  integrations: Array<{ integration: string; provider: string; mode: IntegrationMode; detail: string }>;
  routes: Array<{ source: string; target: string; type: string; description: string; enabled: boolean }>;
}

const isDenied = (v: unknown): v is Denied => typeof v === "object" && v !== null && "denied" in v;

const DOSE_LABEL: Record<string, string> = {
  scheduled: "Coming up",
  reminded: "Reminder sent",
  unconfirmed: "Not confirmed yet",
  checked_in: "Checking in",
  confirmed: "Taken",
  missed: "Not confirmed",
};
const DOSE_STYLE: Record<string, string> = {
  scheduled: "bg-canvas text-ink",
  reminded: "bg-[#fdf3dc] text-warn",
  unconfirmed: "bg-[#fdf3dc] text-warn",
  checked_in: "bg-[#fdf3dc] text-warn",
  confirmed: "bg-care-soft text-ok",
  missed: "bg-[#fde8e6] text-danger",
};
const REFILL_LABEL: Record<string, string> = {
  draft: "Waiting for approval",
  blocked: "Needs information",
  submitted: "Sent to pharmacy (sandbox)",
  ready: "Ready for pickup (sandbox)",
  picked_up: "Picked up",
  rejected: "Rejected by pharmacy",
  out_of_stock: "Out of stock at pharmacy",
  no_refills_remaining: "No refills left",
};
const ORDER_LABEL: Record<string, string> = {
  placed: "Order placed (sandbox)",
  picking: "Being packed (sandbox)",
  out_for_delivery: "Out for delivery (sandbox)",
  delivered: "Delivered (simulated)",
  cancelled: "Cancelled",
  failed: "Failed",
};

function Pill({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-sm font-bold ${className}`}>{children}</span>;
}

function Btn({ onClick, children, kind = "primary", disabled }: { onClick: () => void; children: React.ReactNode; kind?: "primary" | "secondary"; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`min-h-12 rounded-full px-5 text-lg font-bold disabled:opacity-40 ${kind === "primary" ? "bg-care text-white" : "border-2 border-line bg-surface text-ink"}`}
    >
      {children}
    </button>
  );
}

function DeniedNote({ what }: { what: string }) {
  return <EmptyState>You don&apos;t have permission to see {what}. The person decides who can see this.</EmptyState>;
}

export function CareDashboard({ as, title = true, recipient }: { as: "self" | "caregiver" | "neighbor"; title?: boolean; recipient?: string }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState("");
  const [countDraft, setCountDraft] = useState<Record<string, string>>({});
  const [pendingCount, setPendingCount] = useState<{ pendingId: string; question: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);

  // Spoken reminders: same /api/voice/speak route as the chat (Cartesia when live, else labelled browser speech).
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatusInfo | null>(null);
  const [speakReminders, setSpeakReminders] = useState(true);
  const [speaking, setSpeaking] = useState<{ id: string; provider: SpeechProvider | null } | null>(null);
  const speakRef = useRef<SpeakHandle | null>(null);
  const interacted = useRef(false); // browsers only allow audio after the user has interacted with the page
  const seenVoice = useRef<Set<string> | null>(null);

  // Let reminders play later without a tap: unlock audio on the first interaction with the page.
  useEffect(() => installAudioUnlock(), []);

  useEffect(() => {
    fetchVoiceStatus().then((v) => v && setVoiceStatus(v));
    const mark = () => (interacted.current = true);
    window.addEventListener("pointerdown", mark, { once: true });
    window.addEventListener("keydown", mark, { once: true });
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      speakRef.current?.stop();
    };
  }, []);

  const play = useCallback(
    (id: string, text: string) => {
      speakRef.current?.stop();
      const handle = speak(text, {
        preferCartesia: voiceStatus?.provider === "cartesia",
        onProvider: (p) => setSpeaking({ id, provider: p }),
      });
      speakRef.current = handle;
      setSpeaking({ id, provider: null });
      return handle.done.then((r) => {
        if (speakRef.current === handle) {
          speakRef.current = null;
          setSpeaking(null);
        }
        if (r.cartesiaRejected) {
          setVoiceStatus({ provider: "browser", mode: "unavailable", rejected: true, label: "Browser speech (not Cartesia)", detail: "Cartesia rejected the key — using browser speech." });
        }
      });
    },
    [voiceStatus],
  );

  const stopSpeaking = useCallback(() => {
    speakRef.current?.stop();
    speakRef.current = null;
    setSpeaking(null);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/care/dashboard?as=${as}${recipient ? `&recipient=${encodeURIComponent(recipient)}` : ""}`, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? "Couldn't load Care information.");
      setData(null);
      return;
    }
    setError(null);
    setData(json);
  }, [as, recipient]);

  useEffect(() => {
    // Initial load of the viewer's permitted Care data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  async function switchDemo(enabled: boolean) {
    setBusy(true);
    try {
      await fetch("/api/care/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "demo", as: "self", enabled }) });
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  async function act(payload: Record<string, unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch("/api/care/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as, ...(recipient ? { recipient } : {}), ...payload }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "That didn't work.");
      else if (json.pendingId && json.question) {
        setPendingCount({ pendingId: json.pendingId, question: json.question });
        setStatus(json.question);
      } else {
        if (payload.action === "pill_count_confirm") setPendingCount(null);
        const said = json.message ?? json.say ?? json.result?.error;
        setStatus(said ? String(said) : done ?? "Done.");
      }
    } catch {
      setError("Couldn't reach Sahaya. Check your connection and try again.");
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  // Auto-speak new medication prompts (e.g. when the sandbox clock fires a reminder) — only for the person themselves,
  // only after she has interacted with the page, and only if she leaves "Speak reminders" on.
  useEffect(() => {
    if (!data) return;
    const prompts = data.voice.filter((v) => v.direction === "to_user");
    if (seenVoice.current === null) {
      seenVoice.current = new Set(prompts.map((v) => v.id));
      return;
    }
    const fresh = prompts.filter((v) => !seenVoice.current!.has(v.id));
    fresh.forEach((v) => seenVoice.current!.add(v.id));
    if (data.viewer.role !== "older_adult" || !speakReminders || !interacted.current) return;
    const toSay = fresh.filter((v) => v.purpose.startsWith("medication_") || v.purpose === "cooking_step" || v.purpose === "meal_support");
    if (!toSay.length) return;
    let cancelled = false;
    (async () => {
      for (const v of toSay) {
        if (cancelled) break;
        await play(v.id, v.text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, speakReminders, play]);

  if (error && !data) return <p role="alert" className="mx-5 rounded-2xl bg-[#fde8e6] p-4 text-lg text-danger">{error}</p>;
  if (!data) return <p className="px-5 py-4 text-lg text-ink-muted">Loading Care information…</p>;

  const self = data.viewer.role === "older_adult";
  const med = data.medication;
  const groc = data.grocery;
  const meals = data.meals;
  // Home-repair approvals have their own card (Approve / Change time / Decline) in the Home repairs section.
  const genericApprovals = data.support.approvals.filter((a) => a.toolName !== "bookHomeRepair");

  return (
    <div className="pb-6" aria-busy={busy}>
      {title && (
        <header className="px-5 pt-6">
          <h2 className="text-2xl font-bold text-care">Care dashboard</h2>
          <p className="text-lg text-ink-muted">Viewing as {data.viewerLabel}</p>
        </header>
      )}

      {data.profileMode === "demo" && (
        <div className="mx-5 mt-3 rounded-2xl border-2 border-dashed border-line p-3 text-base text-ink-muted">
          <p>
            <strong className="text-ink">Demo profile:</strong> {data.profile?.displayName || "Margaret"} and everything here is fictional sample data,
            kept separate from your own profile. Pharmacy, grocery and delivery are sandbox simulators — no prescriptions are sent, nothing is bought.
            {!self && " Caregiver view is a local preview (there is no sign-in yet); the server still checks this caregiver's real permissions."}
          </p>
          {self && (
            <div className="mt-2">
              <Btn kind="secondary" disabled={busy} onClick={() => switchDemo(false)}>Leave the demo</Btn>
            </div>
          )}
        </div>
      )}

      {/* Sandbox clock */}
      <Section title="Clock">
        <Card>
          <p className="text-xl font-bold">{data.clock.local}</p>
          <p className="text-base text-ink-muted">
            {data.demoMode
              ? `Sandbox clock${data.sandboxClock.simulatedOffsetMinutes ? ` — ${Math.round(data.sandboxClock.simulatedOffsetMinutes / 6) / 10} h ahead of real time` : " — real time"}. Moving it forward runs reminders, refills and deliveries.`
              : "Real time."}
          </p>
          {self && data.demoMode && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "advance", minutes: 20 }, "Moved the sandbox clock 20 minutes ahead.")}>+20 min</Btn>
              <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "advance", minutes: 120 }, "Moved the sandbox clock 2 hours ahead.")}>+2 hours</Btn>
              <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "advance", minutes: 720 }, "Moved the sandbox clock 12 hours ahead.")}>+12 hours</Btn>
              <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "tick" }, "Checked for reminders and updates.")}>Check now</Btn>
            </div>
          )}
        </Card>
      </Section>

      <div aria-live="polite" className="px-5">
        {status && <p role="status" className="rounded-2xl bg-care-soft p-4 text-lg text-ok">{status}</p>}
        {error && <p role="alert" className="mt-2 rounded-2xl bg-[#fde8e6] p-4 text-lg text-danger">{error}</p>}
      </div>

      {/* Caregiver support */}
      <Section title={self ? "Waiting for an OK" : "Needs your attention"}>
        {genericApprovals.length === 0 && data.support.alerts.filter((a) => !a.acknowledgedAt).length === 0 ? (
          <EmptyState>Nothing needs attention right now.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {genericApprovals.map((a) => (
              <li key={a.id}>
                <Card className="border-l-8 border-care">
                  <p className="text-lg font-bold">{a.summary}</p>
                  <p className="text-base text-ink-muted">Expires {a.expires}{a.userOnly ? " · only the person can decide this" : ""}</p>
                  {a.canDecide ? (
                    <div className="mt-3 flex gap-3">
                      <Btn disabled={busy} onClick={() => act({ action: "decide", approvalId: a.id, decision: "approve" }, "Approved.")}>Approve</Btn>
                      <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "decide", approvalId: a.id, decision: "deny" }, "Declined.")}>Decline</Btn>
                    </div>
                  ) : (
                    <p className="mt-2 text-base font-bold text-ink-muted">You can see this but can&apos;t approve it.</p>
                  )}
                </Card>
              </li>
            ))}
            {data.support.alerts.filter((a) => !a.acknowledgedAt).map((a) => (
              <li key={a.id}>
                <Card className={`border-l-8 ${a.severity === "urgent" ? "border-danger" : "border-warn"}`}>
                  <p className="text-lg font-bold">{a.title}</p>
                  <p className="text-base">{a.detail}</p>
                  <p className="text-sm text-ink-muted">{a.when}{a.escalationStatus ? ` · Guardian: ${a.escalationStatus === "route_disabled" ? "route off" : a.escalationStatus}` : ""}</p>
                  <div className="mt-3">
                    <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "acknowledge", alertId: a.id }, "Marked as seen.")}>Mark as seen</Btn>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {data.support.alerts.some((a) => a.acknowledgedAt) && (
          <ul className="mt-3 flex flex-col gap-1 text-base text-ink-muted">
            {data.support.alerts.filter((a) => a.acknowledgedAt).slice(0, 5).map((a) => (
              <li key={a.id}>✓ {a.title} — seen by {a.acknowledgedBy === data.viewer.id ? "you" : a.acknowledgedBy}</li>
            ))}
          </ul>
        )}
        {data.support.helpRequests.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {data.support.helpRequests.map((h) => (
              <li key={h.id} className="rounded-2xl bg-surface p-3 text-base shadow-sm">
                Help request: {h.summary} — <strong>{h.status === "sent" ? "sent to Guardian" : h.status === "route_disabled" ? "not sent (sharing is off)" : h.status}</strong>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Medication */}
      <Section title={self ? "What Care knows about you" : "What Care knows (areas you can see)"}>
        {data.memory.length === 0 ? (
          <EmptyState>
            {self
              ? "Nothing yet. Care learns as you talk — your name, what you like to buy, allergies you tell it about. You can change or delete anything here."
              : "Nothing you have access to."}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.memory.map((f) => (
              <li key={f.id} className="rounded-2xl bg-surface p-3 shadow-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base text-ink-muted">{f.label}</span>
                  <Pill className={f.status === "confirmed" ? "bg-care-soft text-ok" : f.status === "reported" ? "bg-canvas text-ink" : "bg-[#fdf3dc] text-warn"}>
                    {f.status === "confirmed" ? "Confirmed" : f.status === "reported" ? (self ? "You told Care" : "Told to Care") : "Care's guess — not confirmed"}
                  </Pill>
                </div>
                {editing?.id === f.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label htmlFor={`mem-${f.id}`} className="sr-only">New value for {f.label}</label>
                    <input
                      id={`mem-${f.id}`}
                      value={editing.value}
                      maxLength={160}
                      onChange={(e) => setEditing({ id: f.id, value: e.target.value })}
                      className="min-h-12 flex-1 rounded-xl border-2 border-line px-3 text-lg"
                    />
                    <Btn disabled={busy || !editing.value.trim()} onClick={() => act({ action: "memory_correct", factId: f.id, value: editing.value.trim() }, "Saved.").then(() => setEditing(null))}>Save</Btn>
                    <Btn kind="secondary" onClick={() => setEditing(null)}>Cancel</Btn>
                  </div>
                ) : (
                  <p className="mt-1 text-xl">
                    {f.value}
                    {f.status === "inferred" && f.evidence ? <span className="text-base text-ink-muted"> (seen in {f.evidence} orders)</span> : null}
                  </p>
                )}
                {self && editing?.id !== f.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Btn kind="secondary" disabled={busy} onClick={() => setEditing({ id: f.id, value: f.value })}>
                      {f.status === "confirmed" ? "Change" : "Correct or confirm"}
                    </Btn>
                    {forgetting === f.id ? (
                      <>
                        <span className="self-center text-base">Forget this{f.safetyCritical ? " — it will no longer be used to keep you safe" : ""}?</span>
                        <Btn disabled={busy} onClick={() => act({ action: "memory_delete", factId: f.id }, "Forgotten.").then(() => setForgetting(null))}>Yes, forget it</Btn>
                        <Btn kind="secondary" onClick={() => setForgetting(null)}>Keep it</Btn>
                      </>
                    ) : (
                      <Btn kind="secondary" disabled={busy} onClick={() => setForgetting(f.id)}>Forget</Btn>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-base text-ink-muted">{data.storage}.</p>
      </Section>

      <Section title="Medications today">
        {isDenied(med) ? (
          <DeniedNote what="medication information" />
        ) : (
          <div className="flex flex-col gap-3">
            {med.today.map((m) => (
              <Card key={m.medicationId}>
                <p className="text-xl font-bold">{m.name}</p>
                <p className="text-base text-ink-muted">Label: “{m.doseText}”</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {m.doses.map((d) => (
                    <li key={d.doseId} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-lg">{d.slot} · {d.time}</span>
                      <Pill className={DOSE_STYLE[d.state] ?? "bg-canvas"}>
                        {DOSE_LABEL[d.state] ?? d.state}
                        {d.state === "confirmed" && d.confirmedAt ? ` at ${d.confirmedAt}${d.late ? " (late)" : ""}` : ""}
                      </Pill>
                      {self && d.canConfirm && (
                        <Btn disabled={busy} onClick={() => act({ action: "confirm_dose", doseId: d.doseId })}>I&apos;ve taken it</Btn>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-lg">
                  {m.pillsRemaining === null || m.daysOfSupply === null ? (
                    <>Supply not known yet{self ? " — tell Care how many you have, or count them below." : "."}</>
                  ) : (
                    <>
                      About <strong>{m.pillsRemaining}</strong> left ≈ {m.daysOfSupply} day{m.daysOfSupply === 1 ? "" : "s"}
                      {m.daysOfSupply <= m.refillLeadDays && <span className="font-bold text-warn"> · refill needed</span>}
                    </>
                  )}
                </p>
                {self && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label htmlFor={`count-${m.medicationId}`} className="text-base">I counted:</label>
                    <input
                      id={`count-${m.medicationId}`}
                      inputMode="numeric"
                      value={countDraft[m.medicationId] ?? ""}
                      onChange={(e) => setCountDraft({ ...countDraft, [m.medicationId]: e.target.value.replace(/\D/g, "") })}
                      className="min-h-12 w-24 min-w-0 rounded-2xl border-2 border-line px-3 text-lg"
                    />
                    <Btn kind="secondary" disabled={busy || !countDraft[m.medicationId]} onClick={() => act({ action: "pill_count", medicationId: m.medicationId, count: Number(countDraft[m.medicationId]) })}>
                      Update count
                    </Btn>
                  </div>
                )}
              </Card>
            ))}
            {self && pendingCount && (
              <Card className="border-l-8 border-warn">
                <p className="text-lg font-bold">{pendingCount.question}</p>
                <div className="mt-2 flex gap-2">
                  <Btn disabled={busy} onClick={() => act({ action: "pill_count_confirm", pendingId: pendingCount.pendingId, answer: "yes" })}>Yes, that&apos;s right</Btn>
                  <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "pill_count_confirm", pendingId: pendingCount.pendingId, answer: "no" })}>No</Btn>
                </div>
              </Card>
            )}
            {self && (
              <Card>
                <label htmlFor="care-reply" className="text-lg font-bold">Answer Care (typed instead of voice)</label>
                <p className="text-base text-ink-muted">For example “Yes, I&apos;ve taken it” or “I forgot”. Care only marks a dose taken when you say so.</p>
                <div className="mt-2 flex gap-2">
                  <input id="care-reply" value={reply} onChange={(e) => setReply(e.target.value)} className="min-h-12 min-w-0 flex-1 rounded-2xl border-2 border-line px-4 text-lg" />
                  <Btn disabled={busy || !reply.trim()} onClick={() => { act({ action: "voice_reply", text: reply }); setReply(""); }}>Send</Btn>
                </div>
              </Card>
            )}
            <Card>
              <p className="text-lg font-bold">Last 7 days</p>
              <p className="text-lg">
                {med.adherence.onTime} on time · {med.adherence.late} late · {med.adherence.missed} not confirmed
              </p>
              {med.recent.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-base text-ink-muted">
                  {med.recent.map((r) => <li key={r.doseId}>{r.when} — {r.medication}: {r.state === "confirmed" ? (r.late ? "taken (late)" : "taken") : "not confirmed"}</li>)}
                </ul>
              )}
            </Card>
            <p className="text-lg font-bold">Refills</p>
            {med.refills.length === 0 ? (
              <EmptyState>No refills in progress.</EmptyState>
            ) : (
              med.refills.map((r) => (
                <Card key={r.refillId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-lg font-bold">{r.medication}{r.quantity ? ` × ${r.quantity}` : ""}</p>
                    <Pill className={["rejected", "out_of_stock", "no_refills_remaining", "blocked"].includes(r.status) ? "bg-[#fde8e6] text-danger" : "bg-canvas"}>{REFILL_LABEL[r.status] ?? r.status}</Pill>
                  </div>
                  <p className="text-base text-ink-muted">{r.pharmacy ?? "No pharmacy on record"} · updated {r.updated}</p>
                  {r.missing.length > 0 && <p className="text-base text-danger">Missing: {r.missing.join(", ")}</p>}
                  {r.pharmacyMessages.map((m, i) => (
                    <p key={i} className="mt-1 text-sm text-ink-muted">Pharmacy said{m.flagged ? " (contains instructions — ignored)" : ""}: “{m.text}”</p>
                  ))}
                  {self && r.status === "ready" && (
                    <div className="mt-2"><Btn disabled={busy} onClick={() => act({ action: "pickup", refillId: r.refillId }, "Marked as picked up.")}>I picked it up</Btn></div>
                  )}
                </Card>
              ))
            )}
          </div>
        )}
      </Section>

      {/* Grocery */}
      <Section title="Groceries">
        {isDenied(groc) ? (
          <DeniedNote what="grocery information" />
        ) : (
          <div className="flex flex-col gap-3">
            {groc.preferences && (
              <Card>
                <p className="text-lg"><strong>Allergy:</strong> {groc.preferences.allergies.join(", ") || "none"} — products with unknown allergen info are left out</p>
                <p className="text-lg"><strong>Likes:</strong> {groc.preferences.notes.join(" · ")}</p>
                <p className="text-base text-ink-muted">Essentials: {groc.preferences.essentials.join(", ")} · Limits {groc.preferences.limits.perOrder} per order, {groc.preferences.limits.weekly} per week</p>
              </Card>
            )}
            {groc.cart ? (
              <Card>
                <p className="text-lg font-bold">Cart · {groc.cart.total}{groc.cart.deliveryWindow ? ` · ${groc.cart.deliveryWindow}` : ""}</p>
                <ul className="mt-1 flex flex-col gap-1 text-lg">
                  {groc.cart.lines.map((l, i) => <li key={i}>{l.quantity} × {l.name} — {l.price}{l.substitutedFor ? ` (instead of ${l.substitutedFor})` : ""}</li>)}
                </ul>
                {groc.cart.pendingSubstitutions.map((s) => (
                  <div key={s.id} className="mt-3 rounded-2xl bg-[#fdf3dc] p-3">
                    <p className="text-lg">{s.reason}</p>
                    {self && (
                      <div className="mt-2 flex gap-2">
                        <Btn disabled={busy} onClick={() => act({ action: "suggestion", cartId: groc.cart!.cartId, suggestionId: s.id, decision: "accept" }, "Sent for approval.")}>Use {s.substitute.name}</Btn>
                        <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "suggestion", cartId: groc.cart!.cartId, suggestionId: s.id, decision: "decline" })}>No thanks</Btn>
                      </div>
                    )}
                  </div>
                ))}
                {groc.cart.pendingAdditions.map((a) => (
                  <div key={a.id} className="mt-3 rounded-2xl bg-canvas p-3">
                    <p className="text-lg">{a.reason} Add {a.name}?</p>
                    {self && (
                      <div className="mt-2 flex gap-2">
                        <Btn disabled={busy} onClick={() => act({ action: "suggestion", cartId: groc.cart!.cartId, suggestionId: a.id, decision: "accept" })}>Yes, add it</Btn>
                        <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "suggestion", cartId: groc.cart!.cartId, suggestionId: a.id, decision: "decline" })}>No</Btn>
                      </div>
                    )}
                  </div>
                ))}
                {groc.cart.blocked.length > 0 && (
                  <p className="mt-3 text-base text-danger">Left out for safety: {groc.cart.blocked.map((b) => `${b.name} (${b.reasons.join(", ")})`).join("; ")}</p>
                )}
                {self && (
                  <div className="mt-3">
                    <Btn disabled={busy || groc.cart.pendingSubstitutions.length + groc.cart.pendingAdditions.length > 0} onClick={() => act({ action: "order", cartId: groc.cart!.cartId }, "Order sent for approval.")}>Ask to place this order</Btn>
                  </div>
                )}
              </Card>
            ) : (
              self && <Btn disabled={busy} onClick={() => act({ action: "grocery_usual" }, "Your usual cart is ready to review.")}>Get my usual groceries</Btn>
            )}
            <p className="text-lg font-bold">Orders</p>
            {groc.orders.length === 0 ? (
              <EmptyState>No orders yet.</EmptyState>
            ) : (
              groc.orders.map((o) => (
                <Card key={o.orderId}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-lg font-bold">{o.items} items · {o.total}</p>
                    <Pill className={o.status === "delivered" ? "bg-care-soft text-ok" : "bg-canvas"}>{ORDER_LABEL[o.status] ?? o.status}</Pill>
                  </div>
                  <p className="text-base text-ink-muted">{o.window}</p>
                  {o.confirmation && <p className="text-base">{o.confirmation}</p>}
                </Card>
              ))
            )}
          </div>
        )}
      </Section>

      {/* Pantry and meals */}
      <Section title="Pantry and meals">
        {isDenied(meals) ? (
          <DeniedNote what="pantry and meal information" />
        ) : (
          <div className="flex flex-col gap-3">
            <Card>
              <p className="text-lg font-bold">Use soon</p>
              {meals.expiringSoon.length === 0 ? (
                <p className="text-lg text-ink-muted">Nothing is expiring in the next 3 days.</p>
              ) : (
                <ul className="text-lg">{meals.expiringSoon.map((p) => <li key={p.name}>{p.name} — {p.expired ? "expired" : `by ${p.expiresOn}`}</li>)}</ul>
              )}
              <details className="mt-2">
                <summary className="min-h-12 cursor-pointer text-lg font-bold text-care">Everything in the pantry ({meals.pantry.length})</summary>
                <ul className="mt-1 text-base">
                  {meals.pantry.map((p) => <li key={p.name}>{p.name} — {p.quantity} {p.unit}{p.allergenInfo !== "complete" ? " · allergen info unknown" : ""}</li>)}
                </ul>
              </details>
            </Card>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-lg font-bold">Dinner ideas</p>
                {self && <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "meals" }, "Here are some ideas.")}>Suggest dinners</Btn>}
              </div>
              {meals.plan ? (
                <>
                  <ul className="mt-2 flex flex-col gap-2">
                    {meals.plan.ideas.map((i) => (
                      <li key={i.recipeId} className="rounded-2xl bg-canvas p-3">
                        <p className="text-lg font-bold">{i.name} · {i.minutes} min</p>
                        <p className="text-base text-ink-muted">Uses {i.uses.join(", ")}{i.missing.length ? ` · needs ${i.missing.join(", ")}` : ""}</p>
                        {self && <div className="mt-2"><Btn disabled={busy} onClick={() => act({ action: "cook", recipeId: i.recipeId })}>Cook this with me</Btn></div>}
                      </li>
                    ))}
                  </ul>
                  {meals.plan.excluded.length > 0 && (
                    <p className="mt-2 text-base text-ink-muted">Left out: {meals.plan.excluded.map((e) => `${e.name} (${e.reasons.join("; ")})`).join(" · ")}</p>
                  )}
                </>
              ) : (
                <p className="text-lg text-ink-muted">No meal ideas yet.</p>
              )}
            </Card>
            {meals.cooking && meals.cooking.status === "active" && (
              <Card className="border-l-8 border-care">
                <p className="text-base font-bold uppercase tracking-wide text-ink-muted">Cooking: {meals.cooking.recipe}</p>
                <p className="mt-1 whitespace-pre-line text-xl leading-relaxed">{meals.cooking.say}</p>
                {self && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Btn disabled={busy} onClick={() => act({ action: "cooking", text: "next" })}>Next</Btn>
                    <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "cooking", text: "repeat" })}>Repeat</Btn>
                    <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "cooking", text: "slower" })}>Slower</Btn>
                    <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "cooking", text: "simpler" })}>Simpler</Btn>
                    <Btn kind="secondary" disabled={busy} onClick={() => act({ action: "cooking", text: "cooking is getting hard for me" })}>This is getting hard</Btn>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}
      </Section>

      {/* Home repairs: the person's own flow; caregivers with the view-only scope see bookings */}
      {self && !isDenied(data.homeServices) && "audit" in data.homeServices && (
        <Section title="Home repairs">
          <HomeRepairHelp view={data.homeServices} onChanged={refresh} />
        </Section>
      )}
      {!self && !isDenied(data.homeServices) && (
        <Section title="Home repairs">
          {data.homeServices.bookings.length === 0 ? (
            <EmptyState>No home repairs booked.</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">{data.homeServices.bookings.map((b) => <BookingConfirmation key={b.bookingId} b={b} />)}</div>
          )}
        </Section>
      )}

      {self && data.routes.length > 0 && (
        <Section title="What Care may share">
          <ul className="flex flex-col gap-2">
            {data.routes.map((r) => (
              <li key={`${r.source}-${r.target}-${r.type}`}>
                <Card className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block font-bold">{r.source} → {r.target}</span>
                    <span className="block text-base text-ink-muted">{r.description}</span>
                  </span>
                  <Btn kind={r.enabled ? "primary" : "secondary"} disabled={busy} onClick={() => act({ action: "consent", source: r.source, target: r.target, type: r.type, enabled: !r.enabled }, r.enabled ? "Turned off." : "Turned on.")}>
                    {r.enabled ? "On" : "Off"}
                  </Btn>
                </Card>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.voice.length > 0 && (
        <Section title="Voice prompts">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-base text-ink-muted">
            <span>
              Voice: <strong className="text-ink">{voiceStatus?.label ?? "checking…"}</strong>
              {voiceStatus?.rejected ? " — Cartesia rejected the key" : ""} · no phone calls
            </span>
            {self && (
              <button
                onClick={() => {
                  setSpeakReminders(!speakReminders);
                  if (speakReminders) stopSpeaking();
                }}
                aria-pressed={speakReminders}
                className="min-h-12 rounded-full border-2 border-line bg-surface px-4 text-base font-bold text-ink"
              >
                Speak reminders: {speakReminders ? "On" : "Off"}
              </button>
            )}
          </div>
          {speaking && (
            <div role="status" className="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-care-soft p-3">
              <span className="text-lg font-bold">
                Speaking{speaking.provider ? ` · ${speaking.provider === "cartesia" ? "Cartesia voice" : "browser voice (not Cartesia)"}` : "…"}
              </span>
              <button onClick={stopSpeaking} className="min-h-12 rounded-full bg-ink px-5 text-lg font-bold text-white">Stop</button>
            </div>
          )}
          <ul className="flex flex-col gap-2 text-base">
            {data.voice.map((v) => (
              <li key={v.id} className={`flex items-start justify-between gap-2 ${v.direction === "to_user" ? "" : "text-ink-muted"}`}>
                <span>
                  {v.at} · {v.direction === "to_user" ? "Care" : self ? "You" : "Them"}: “{v.text}”
                  {v.direction === "to_user" && v.simulated && <span className="text-ink-muted"> (recorded, not delivered)</span>}
                </span>
                {v.direction === "to_user" && (
                  <button
                    onClick={() => (speaking?.id === v.id ? stopSpeaking() : play(v.id, v.text))}
                    aria-label={speaking?.id === v.id ? "Stop" : "Play this prompt"}
                    className="min-h-12 shrink-0 rounded-full border-2 border-line bg-surface px-4 font-bold text-care"
                  >
                    {speaking?.id === v.id ? "■ Stop" : "▶ Play"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {self && data.profileMode === "real" && (
        <Section title="Want to look around first?">
          <Card>
            <p className="text-lg">You can open a demo with fictional sample data (a pretend person, medications and groceries). It&apos;s kept completely separate from your own information.</p>
            <div className="mt-3">
              <Btn kind="secondary" disabled={busy} onClick={() => switchDemo(true)}>Try the demo</Btn>
            </div>
          </Card>
        </Section>
      )}

      <Section title="Care connections">
        <ul className="grid gap-2">
          {data.integrations.map((i) => (
            <li key={i.integration} className="flex items-start justify-between gap-3 rounded-2xl bg-surface p-3 shadow-sm">
              <span>
                <span className="block font-bold capitalize">{i.integration === "commerce" ? "Grocery" : i.integration}</span>
                <span className="block text-base text-ink-muted">{i.detail}</span>
              </span>
              <ModeBadge mode={i.mode} />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function CareFamilySection() {
  const [as, setAs] = useState<"caregiver" | "neighbor">("caregiver");
  const [mode, setMode] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Array<{ recipientId: string; label: string | null; scopes: string[]; expiresAt: number | null }>>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [dash, cg] = await Promise.all([
          fetch("/api/care/dashboard?as=self", { cache: "no-store" }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
          fetch("/api/care/caregivers", { cache: "no-store" }).then(async (r) => ({ ok: r.ok, body: await r.json() })),
        ]);
        if (!live) return;
        if (!dash.ok) {
          setProblem(dash.body?.error ?? "Couldn't load this page.");
          setMode("real");
          return;
        }
        setMode(dash.body.identityKind === "local" ? (dash.body.profileMode ?? "real") : "real");
        if (cg.ok) setRecipients(cg.body.recipients ?? []);
      } catch {
        if (live) {
          setProblem("Couldn't reach Sahaya. Check your connection and try again.");
          setMode("real");
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  if (mode === null) return <p className="px-5 py-4 text-lg text-ink-muted" role="status">Loading…</p>;
  if (problem) return <p role="alert" className="mx-5 rounded-2xl border-2 border-line p-4 text-lg text-ink-muted">{problem}</p>;
  if (recipients.length) {
    return (
      <div>
        <div role="group" aria-label="Choose whose Care information to view" className="flex flex-wrap gap-2 px-5">
          <span className="w-full text-base text-ink-muted">People who gave you access — you&apos;ll see only what each person allowed:</span>
          {recipients.map((r, i) => (
            <Btn key={r.recipientId} kind={chosen === r.recipientId ? "primary" : "secondary"} onClick={() => setChosen(r.recipientId)}>
              {r.label ?? `Person ${i + 1}`}
            </Btn>
          ))}
        </div>
        {chosen && <CareDashboard key={chosen} as="self" recipient={chosen} title={false} />}
      </div>
    );
  }
  if (mode !== "demo") {
    return (
      <p className="mx-5 rounded-2xl border-2 border-dashed border-line p-4 text-lg text-ink-muted">
        Nobody has given you access to their Care information. To let someone help you, share access from the Care page using
        their Sahaya ID. To preview how it works, open the demo from the Care page.
      </p>
    );
  }
  return (
    <div>
      <div role="group" aria-label="Preview the Care view as" className="flex flex-wrap gap-2 px-5">
        <span className="w-full text-base text-ink-muted">Demo preview — see what each caregiver is allowed to see:</span>
        <Btn kind={as === "caregiver" ? "primary" : "secondary"} onClick={() => setAs("caregiver")}>Ellen · daughter</Btn>
        <Btn kind={as === "neighbor" ? "primary" : "secondary"} onClick={() => setAs("neighbor")}>Sam · neighbor</Btn>
      </div>
      <CareDashboard key={as} as={as} title={false} />
    </div>
  );
}
