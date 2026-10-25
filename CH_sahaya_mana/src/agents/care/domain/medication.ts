/**
 * Deterministic medication logic: dose generation, the dose state machine, supply and refill
 * thresholds, and missed-dose escalation. Pure functions over plain records — no LLM, no I/O —
 * so every safety-relevant rule is unit-testable.
 *
 * Non-negotiables encoded here:
 *  - A dose becomes `confirmed` only through an explicit confirmation event. Silence never confirms.
 *  - The original dose record and its full history are kept; late or corrected information is appended.
 *  - Duplicate confirmations are no-ops and never decrement supply twice.
 *  - Schedules are only ever changed by an explicit, approved schedule change (see CareService).
 */
import { DAY, HOUR, addLocalDays, localDateOf, minutes, zonedTimeToUtc } from "./time";

export type DoseState = "scheduled" | "reminded" | "confirmed" | "unconfirmed" | "checked_in" | "missed";

export interface ScheduledTime {
  /** Stable id within the medication, e.g. "morning". */
  slot: string;
  /** Local wall time from the prescription label, HH:MM. */
  time: string;
}

export interface DoseRules {
  /** Earliest a dose can be confirmed, relative to its scheduled time. */
  windowBeforeMin: number;
  /** End of the on-time window after the scheduled time; unconfirmed doses become missed here. */
  windowAfterMin: number;
  /** Unanswered reminder → follow-up (state `unconfirmed`) after this long. */
  followUpAfterMin: number;
  /** Still unconfirmed → start a check-in conversation (state `checked_in`) after this long from the reminder. */
  checkInAfterMin: number;
  /** A missed dose can still be confirmed as taken late for this long after the window closes. */
  lateConfirmationMaxMin: number;
}

export const DEFAULT_DOSE_RULES: DoseRules = {
  windowBeforeMin: 60,
  windowAfterMin: 120,
  followUpAfterMin: 20,
  checkInAfterMin: 45,
  lateConfirmationMaxMin: 4 * 60,
};

export interface FillInfo {
  date: string; // YYYY-MM-DD
  quantity: number;
}

export interface PharmacyInfo {
  id: string;
  name: string;
  phone?: string;
}

export interface ScheduleChange {
  at: number;
  by: string;
  approvalId?: string;
  from: ScheduledTime[];
  to: ScheduledTime[];
  source: "prescription_label";
}

export interface Medication {
  id: string;
  name: string;
  /** Exactly as recorded from the prescription label. Never generated or paraphrased. */
  doseText: string;
  purpose?: string;
  schedule: ScheduledTime[];
  timeZone: string;
  rules: DoseRules;
  /** Current supply estimate (pills/tablets). Meaningless while `supplyKnown` is false. */
  pillsRemaining: number;
  /** False when the person hasn't told Care how many they have (no refill estimates until they do). */
  supplyKnown?: boolean;
  /** Pills per prescribed dose, from the label. */
  pillsPerDose: number;
  /** Request a refill when estimated days of supply falls to or below this. */
  refillLeadDays: number;
  pharmacy?: PharmacyInfo;
  rxNumber?: string;
  lastFill?: FillInfo;
  refillsRemaining?: number;
  /** Who entered the schedule and from what. */
  scheduleSource: { enteredBy: string; source: "prescription_label"; at: number };
  scheduleHistory: ScheduleChange[];
  supplyHistory: Array<{ at: number; change: number; reason: string; resultingCount: number; by: string }>;
  active: boolean;
  demo: boolean;
}

export type DoseEventKind =
  | "remind"
  | "follow_up"
  | "start_check_in"
  | "check_in_response"
  | "confirm"
  | "window_closed"
  | "correction";

export interface DoseHistoryEntry {
  at: number;
  event: DoseEventKind;
  from: DoseState;
  to: DoseState;
  by: string;
  note?: string;
}

export type CheckInResponse = "taken" | "not_taken" | "unsure" | "no_answer";

export interface DoseRecord {
  /** `${medicationId}:${localDate}:${slot}` — the idempotency key for this dose. */
  id: string;
  medicationId: string;
  slot: string;
  localDate: string;
  scheduledTime: string;
  timeZone: string;
  scheduledAt: number;
  windowStart: number;
  windowEnd: number;
  state: DoseState;
  remindedAt?: number;
  followUpAt?: number;
  checkInAt?: number;
  confirmation?: { at: number; by: string; late: boolean; via: "voice" | "text" | "dashboard" };
  checkInResponses: Array<{ at: number; response: CheckInResponse }>;
  supplyDecremented: boolean;
  corrected?: boolean;
  history: DoseHistoryEntry[];
}

export class DoseTransitionError extends Error {
  constructor(
    readonly code: "INVALID_TRANSITION" | "NOT_DUE" | "TOO_LATE" | "NOT_EXPLICIT",
    message: string,
  ) {
    super(message);
    this.name = "DoseTransitionError";
  }
}

export function doseId(medicationId: string, localDate: string, slot: string) {
  return `${medicationId}:${localDate}:${slot}`;
}

/** Build the dose records a medication's schedule produces on one local date. */
export function dosesForDate(med: Medication, localDate: string): DoseRecord[] {
  return med.schedule.map((s) => {
    const scheduledAt = zonedTimeToUtc(localDate, s.time, med.timeZone);
    return {
      id: doseId(med.id, localDate, s.slot),
      medicationId: med.id,
      slot: s.slot,
      localDate,
      scheduledTime: s.time,
      timeZone: med.timeZone,
      scheduledAt,
      windowStart: scheduledAt - minutes(med.rules.windowBeforeMin),
      windowEnd: scheduledAt + minutes(med.rules.windowAfterMin),
      state: "scheduled",
      checkInResponses: [],
      supplyDecremented: false,
      history: [],
    };
  });
}

/** Local dates whose doses can be relevant at `now` (yesterday, today, tomorrow in the med's zone). */
export function relevantDates(med: Medication, now: number): string[] {
  const today = localDateOf(now, med.timeZone);
  return [addLocalDays(today, -1), today, addLocalDays(today, 1)];
}

function push(dose: DoseRecord, entry: Omit<DoseHistoryEntry, "from">, patch: Partial<DoseRecord> = {}): DoseRecord {
  return {
    ...dose,
    ...patch,
    state: entry.to,
    history: [...dose.history, { ...entry, from: dose.state }],
  };
}

export type TimerAction = "remind" | "follow_up" | "start_check_in" | "window_closed";

/**
 * The next time-driven transition for a dose at `now`, if any. Pure: the caller applies it with
 * `applyTimer` and performs the side effect (voice prompt, alert) exactly once per transition.
 */
export function dueTimer(dose: DoseRecord, med: Medication, now: number): TimerAction | null {
  const r = med.rules;
  switch (dose.state) {
    case "scheduled":
      if (now > dose.windowEnd) return "window_closed";
      if (now >= dose.scheduledAt) return "remind";
      return null;
    case "reminded":
      if (now > dose.windowEnd) return "window_closed";
      if (dose.remindedAt !== undefined && now >= dose.remindedAt + minutes(r.followUpAfterMin)) return "follow_up";
      return null;
    case "unconfirmed":
      if (now > dose.windowEnd) return "window_closed";
      if (dose.remindedAt !== undefined && now >= dose.remindedAt + minutes(r.checkInAfterMin)) return "start_check_in";
      return null;
    case "checked_in":
      if (now > dose.windowEnd) return "window_closed";
      return null;
    default:
      return null;
  }
}

export function applyTimer(dose: DoseRecord, action: TimerAction, now: number): DoseRecord {
  const by = "system:care_scheduler";
  const allowed: Record<TimerAction, DoseState[]> = {
    remind: ["scheduled"],
    follow_up: ["reminded"],
    start_check_in: ["unconfirmed"],
    window_closed: ["scheduled", "reminded", "unconfirmed", "checked_in"],
  };
  if (!allowed[action].includes(dose.state)) {
    throw new DoseTransitionError("INVALID_TRANSITION", `cannot ${action} a dose that is ${dose.state}`);
  }
  switch (action) {
    case "remind":
      return push(dose, { at: now, event: "remind", to: "reminded", by }, { remindedAt: now });
    case "follow_up":
      return push(dose, { at: now, event: "follow_up", to: "unconfirmed", by }, { followUpAt: now });
    case "start_check_in":
      return push(dose, { at: now, event: "start_check_in", to: "checked_in", by }, { checkInAt: now });
    case "window_closed":
      // Not confirmed by the end of the window: missed. Never inferred as taken.
      return push(dose, { at: now, event: "window_closed", to: "missed", by, note: "no explicit confirmation in window" });
  }
}

export interface ConfirmInput {
  /** Must be literally true: the user explicitly said they took this dose. */
  explicit: boolean;
  by: string;
  via: "voice" | "text" | "dashboard";
}

export type ConfirmOutcome =
  | { kind: "confirmed"; dose: DoseRecord; late: boolean }
  | { kind: "duplicate"; dose: DoseRecord };

/**
 * Explicit confirmation that the user took the dose.
 *  - before the window opens → NOT_DUE (nothing recorded)
 *  - inside the window → confirmed (on time)
 *  - after the window, within lateConfirmationMaxMin → confirmed with late=true (missed history kept)
 *  - later than that → TOO_LATE (nothing recorded as a dose; the caller may keep a note)
 *  - already confirmed → duplicate (no-op; supply is not touched again)
 */
export function confirmDose(dose: DoseRecord, med: Medication, input: ConfirmInput, now: number): ConfirmOutcome {
  if (input.explicit !== true) {
    throw new DoseTransitionError("NOT_EXPLICIT", "a dose is only confirmed when the user explicitly says they took it");
  }
  if (dose.state === "confirmed") return { kind: "duplicate", dose };
  if (now < dose.windowStart) {
    throw new DoseTransitionError("NOT_DUE", "this dose is not due yet, so it can't be confirmed");
  }
  const late = now > dose.windowEnd;
  if (late && now > dose.windowEnd + minutes(med.rules.lateConfirmationMaxMin)) {
    throw new DoseTransitionError("TOO_LATE", "this dose is too far in the past to record as taken");
  }
  let current = dose;
  if (late && current.state !== "missed") {
    // The window closed before the scheduler ran; record the miss first so history stays truthful.
    current = applyTimer(current, "window_closed", dose.windowEnd);
  }
  const next = push(
    current,
    { at: now, event: "confirm", to: "confirmed", by: input.by, note: late ? "confirmed late" : undefined },
    { confirmation: { at: now, by: input.by, late, via: input.via } },
  );
  return { kind: "confirmed", dose: next, late };
}

/** Record the user's answer to a reminder or check-in without guessing. Only `taken` (explicit) confirms. */
export function recordCheckInResponse(dose: DoseRecord, response: CheckInResponse, now: number, by: string): DoseRecord {
  if (dose.state === "confirmed" || dose.state === "missed" || dose.state === "scheduled") {
    // Still keep the response in the audit trail, but no state change.
    return { ...dose, checkInResponses: [...dose.checkInResponses, { at: now, response }] };
  }
  return push(
    { ...dose, checkInResponses: [...dose.checkInResponses, { at: now, response }] },
    { at: now, event: "check_in_response", to: dose.state, by, note: response },
  );
}

/** The user (or the person who recorded it) corrects an earlier "taken". History is preserved. */
export function correctConfirmation(dose: DoseRecord, now: number, by: string, note: string): DoseRecord {
  if (dose.state !== "confirmed") {
    throw new DoseTransitionError("INVALID_TRANSITION", `only a confirmed dose can be corrected (dose is ${dose.state})`);
  }
  const to: DoseState = now > dose.windowEnd ? "missed" : "unconfirmed";
  return push(dose, { at: now, event: "correction", to, by, note: note.slice(0, 200) }, {
    confirmation: undefined,
    corrected: true,
  });
}

// ── Supply ─────────────────────────────────────────────────────────────────

export function dosesPerDay(med: Medication): number {
  return Math.max(1, med.schedule.length);
}

/** Whole days of supply left at the prescribed rate. */
export function daysOfSupply(med: Medication): number {
  if (med.supplyKnown === false) return Infinity;
  const perDay = med.pillsPerDose * dosesPerDay(med);
  if (perDay <= 0) return Infinity;
  return Math.floor(med.pillsRemaining / perDay);
}

export function needsRefill(med: Medication): boolean {
  return med.active && daysOfSupply(med) <= med.refillLeadDays;
}

/** Decrement supply for a newly confirmed dose. Idempotent via `dose.supplyDecremented`. */
export function applyDoseToSupply(med: Medication, dose: DoseRecord, now: number, by: string) {
  if (dose.state !== "confirmed" || dose.supplyDecremented) return { med, dose, changed: false };
  if (med.supplyKnown === false) return { med, dose: { ...dose, supplyDecremented: true }, changed: true };
  const next = Math.max(0, med.pillsRemaining - med.pillsPerDose);
  return {
    med: {
      ...med,
      pillsRemaining: next,
      supplyHistory: [
        ...med.supplyHistory,
        { at: now, change: next - med.pillsRemaining, reason: `dose ${dose.id} confirmed`, resultingCount: next, by },
      ],
    },
    dose: { ...dose, supplyDecremented: true },
    changed: true,
  };
}

/** Reverse a supply decrement after a correction. */
export function restoreDoseSupply(med: Medication, dose: DoseRecord, now: number, by: string) {
  if (!dose.supplyDecremented) return { med, dose };
  if (med.supplyKnown === false) return { med, dose: { ...dose, supplyDecremented: false } };
  const next = med.pillsRemaining + med.pillsPerDose;
  return {
    med: {
      ...med,
      pillsRemaining: next,
      supplyHistory: [
        ...med.supplyHistory,
        { at: now, change: med.pillsPerDose, reason: `dose ${dose.id} corrected`, resultingCount: next, by },
      ],
    },
    dose: { ...dose, supplyDecremented: false },
  };
}

/** Set the supply estimate to a count the user reported and then explicitly confirmed. */
export function setReportedCount(med: Medication, count: number, now: number, by: string): Medication {
  if (!Number.isInteger(count) || count < 0 || count > 2000) throw new Error("pill count must be a whole number 0–2000");
  return {
    ...med,
    pillsRemaining: count,
    supplyKnown: true,
    supplyHistory: [
      ...med.supplyHistory,
      { at: now, change: count - med.pillsRemaining, reason: "user-reported count (confirmed)", resultingCount: count, by },
    ],
  };
}

// ── Escalation ─────────────────────────────────────────────────────────────

export interface EscalationRule {
  missedDoses: number;
  withinDays: number;
}

export const DEFAULT_ESCALATION: EscalationRule = { missedDoses: 2, withinDays: 3 };

/**
 * Missed doses (state `missed`) whose scheduled time falls in the trailing window. Late-confirmed doses
 * are `confirmed` and therefore don't count. Returns the dose ids that warrant a new caregiver alert, or
 * null when the rule isn't met or every qualifying dose was already alerted on.
 */
export function evaluateMissedDoseEscalation(
  doses: DoseRecord[],
  now: number,
  alreadyAlerted: ReadonlySet<string>,
  rule: EscalationRule = DEFAULT_ESCALATION,
): string[] | null {
  const since = now - rule.withinDays * DAY;
  const missed = doses
    .filter((d) => d.state === "missed" && d.scheduledAt >= since && d.scheduledAt <= now)
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
  if (missed.length < rule.missedDoses) return null;
  if (missed.every((d) => alreadyAlerted.has(d.id))) return null;
  return missed.map((d) => d.id);
}

/** Adherence for display: counts per final state over the given doses. */
export function adherenceSummary(doses: DoseRecord[]) {
  const done = doses.filter((d) => d.state === "confirmed" || d.state === "missed");
  const onTime = done.filter((d) => d.state === "confirmed" && !d.confirmation?.late).length;
  const late = done.filter((d) => d.state === "confirmed" && d.confirmation?.late).length;
  const missed = done.filter((d) => d.state === "missed").length;
  return { total: done.length, onTime, late, missed };
}

export const _test = { HOUR };
