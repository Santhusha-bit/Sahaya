import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOSE_RULES,
  DoseTransitionError,
  applyDoseToSupply,
  applyTimer,
  confirmDose,
  correctConfirmation,
  daysOfSupply,
  dosesForDate,
  dueTimer,
  evaluateMissedDoseEscalation,
  needsRefill,
  recordCheckInResponse,
  setReportedCount,
  type DoseRecord,
  type Medication,
} from "@/agents/care/domain/medication";
import { classifyDoseReply, classifyYesNo, detectMedicationConcern, extractPillCount } from "@/agents/care/domain/language";
import { DAY, localTimeOf, zonedTimeToUtc } from "@/agents/care/domain/time";

const MIN = 60_000;
const TZ = "America/Los_Angeles";

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: "m1",
    name: "Testamol (fictional)",
    doseText: "Take 1 tablet every morning.",
    schedule: [{ slot: "morning", time: "08:00" }],
    timeZone: TZ,
    rules: DEFAULT_DOSE_RULES,
    pillsRemaining: 10,
    pillsPerDose: 1,
    refillLeadDays: 5,
    scheduleSource: { enteredBy: "test", source: "prescription_label", at: 0 },
    scheduleHistory: [],
    supplyHistory: [],
    active: true,
    demo: true,
    ...over,
  };
}

const dose = (m = med(), date = "2026-10-26") => dosesForDate(m, date)[0];
const run = (d: DoseRecord, m: Medication, now: number) => {
  for (let a = dueTimer(d, m, now); a; a = dueTimer(d, m, now)) d = applyTimer(d, a, now);
  return d;
};
const yes = { explicit: true, by: "user", via: "voice" as const };

describe("dose times, time zones and DST", () => {
  it("computes local 08:00 in the medication's zone (PDT vs PST)", () => {
    const summer = dose(med(), "2026-10-26");
    const winter = dose(med(), "2026-11-02");
    expect(new Date(summer.scheduledAt).toISOString()).toBe("2026-10-26T15:00:00.000Z");
    expect(new Date(winter.scheduledAt).toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(localTimeOf(winter.scheduledAt, TZ)).toBe("08:00");
  });

  it("keeps 08:00 local across the fall-back day (25-hour day)", () => {
    const before = dose(med(), "2026-10-31");
    const on = dose(med(), "2026-11-01");
    expect(on.scheduledAt - before.scheduledAt).toBe(25 * 60 * MIN);
    expect(localTimeOf(on.scheduledAt, TZ)).toBe("08:00");
  });

  it("spring forward: a nonexistent 02:30 dose moves forward by the gap to 03:30", () => {
    const m = med({ schedule: [{ slot: "night", time: "02:30" }] });
    const d = dose(m, "2026-03-08");
    expect(localTimeOf(d.scheduledAt, TZ)).toBe("03:30");
  });

  it("fall back: an ambiguous 01:30 dose uses the first occurrence (PDT)", () => {
    expect(new Date(zonedTimeToUtc("2026-11-01", "01:30", TZ)).toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("uses each medication's own zone", () => {
    const ny = dose(med({ timeZone: "America/New_York" }), "2026-10-26");
    expect(new Date(ny.scheduledAt).toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });
});

describe("dose state machine", () => {
  const m = med();
  const d0 = dose(m);

  it("scheduled → reminded at the scheduled time, not before", () => {
    expect(dueTimer(d0, m, d0.scheduledAt - MIN)).toBeNull();
    const d = run(d0, m, d0.scheduledAt);
    expect(d.state).toBe("reminded");
    expect(d.remindedAt).toBe(d0.scheduledAt);
  });

  it("unanswered reminder → unconfirmed (follow-up) → checked_in → missed; never confirmed by silence", () => {
    let d = run(d0, m, d0.scheduledAt);
    d = run(d, m, d0.scheduledAt + 20 * MIN);
    expect(d.state).toBe("unconfirmed");
    d = run(d, m, d0.scheduledAt + 45 * MIN);
    expect(d.state).toBe("checked_in");
    d = run(d, m, d.windowEnd + 1);
    expect(d.state).toBe("missed");
    expect(d.confirmation).toBeUndefined();
    expect(d.history.map((h) => h.to)).toEqual(["reminded", "unconfirmed", "checked_in", "missed"]);
  });

  it("a long gap closes the window without sending stale reminders", () => {
    const d = run(d0, m, d0.windowEnd + 5 * MIN);
    expect(d.state).toBe("missed");
    expect(d.history.map((h) => h.event)).toEqual(["window_closed"]);
  });

  it("rejects invalid transitions", () => {
    expect(() => applyTimer(d0, "follow_up", d0.scheduledAt)).toThrow(DoseTransitionError);
    const confirmed = (confirmDose(run(d0, m, d0.scheduledAt), m, yes, d0.scheduledAt + MIN) as { dose: DoseRecord }).dose;
    expect(() => applyTimer(confirmed, "window_closed", confirmed.windowEnd + 1)).toThrow(/cannot window_closed/);
    expect(() => correctConfirmation(d0, d0.scheduledAt, "u", "x")).toThrow(/only a confirmed dose/);
  });

  it("confirms only on an explicit confirmation", () => {
    expect(() => confirmDose(d0, m, { ...yes, explicit: false }, d0.scheduledAt)).toThrow(/explicitly/);
  });

  it("confirmation inside the window is on time; within the early window too", () => {
    const early = confirmDose(d0, m, yes, d0.scheduledAt - 30 * MIN);
    expect(early).toMatchObject({ kind: "confirmed", late: false });
    const checkedIn = run(run(run(d0, m, d0.scheduledAt), m, d0.scheduledAt + 20 * MIN), m, d0.scheduledAt + 45 * MIN);
    const onTime = confirmDose(checkedIn, m, yes, d0.scheduledAt + 50 * MIN);
    expect(onTime).toMatchObject({ kind: "confirmed", late: false });
    if (onTime.kind === "confirmed") expect(onTime.dose.history.at(-1)).toMatchObject({ from: "checked_in", to: "confirmed" });
  });

  it("rejects confirmation for a dose that isn't due yet and records nothing", () => {
    expect(() => confirmDose(d0, m, yes, d0.windowStart - 1)).toThrow(/not due/);
  });

  it("late confirmation keeps the missed history and is flagged late", () => {
    const missed = run(d0, m, d0.windowEnd + 1);
    const res = confirmDose(missed, m, yes, d0.windowEnd + 3 * 60 * MIN);
    expect(res.kind).toBe("confirmed");
    if (res.kind !== "confirmed") return;
    expect(res.late).toBe(true);
    expect(res.dose.history.map((h) => h.to)).toEqual(["missed", "confirmed"]);
    expect(res.dose.confirmation?.late).toBe(true);
  });

  it("records the miss first when a late confirmation arrives before the scheduler ran", () => {
    const res = confirmDose(run(d0, m, d0.scheduledAt), m, yes, d0.windowEnd + 10 * MIN);
    if (res.kind !== "confirmed") throw new Error("expected confirmation");
    expect(res.dose.history.map((h) => h.to)).toEqual(["reminded", "missed", "confirmed"]);
  });

  it("refuses to record a dose far in the past", () => {
    expect(() => confirmDose(run(d0, m, d0.windowEnd + 1), m, yes, d0.windowEnd + 5 * 60 * MIN)).toThrow(/too far/);
  });

  it("duplicate confirmations are no-ops", () => {
    const first = confirmDose(d0, m, yes, d0.scheduledAt);
    if (first.kind !== "confirmed") throw new Error();
    const second = confirmDose(first.dose, m, yes, d0.scheduledAt + MIN);
    expect(second.kind).toBe("duplicate");
    expect(second.dose.history).toHaveLength(first.dose.history.length);
  });

  it("check-in answers are recorded without changing state unless explicitly taken", () => {
    const d = run(run(run(d0, m, d0.scheduledAt), m, d0.scheduledAt + 20 * MIN), m, d0.scheduledAt + 45 * MIN);
    const after = recordCheckInResponse(d, "not_taken", d0.scheduledAt + 46 * MIN, "user");
    expect(after.state).toBe("checked_in");
    expect(after.checkInResponses).toEqual([{ at: d0.scheduledAt + 46 * MIN, response: "not_taken" }]);
  });

  it("a correction keeps history and moves the dose back", () => {
    const c = confirmDose(d0, m, yes, d0.scheduledAt);
    if (c.kind !== "confirmed") throw new Error();
    const fixed = correctConfirmation(c.dose, d0.scheduledAt + 5 * MIN, "user", "actually didn't");
    expect(fixed.state).toBe("unconfirmed");
    expect(fixed.corrected).toBe(true);
    expect(fixed.history.map((h) => h.to)).toEqual(["confirmed", "unconfirmed"]);
  });
});

describe("reply classification (deterministic gate)", () => {
  it.each([
    ["Yes, I've taken it now.", "taken"],
    ["I took it", "taken"],
    ["Oh, I forgot! I'm taking it now.", "not_taken"],
    ["No, not yet", "not_taken"],
    ["I forgot, but I've taken it now", "taken"],
    ["I think I took it", "unsure"],
    ["maybe", "unsure"],
    ["I can't remember", "unsure"],
    ["", "no_answer"],
    ["what time is it?", "unsure"],
  ])("%s → %s", (text, expected) => {
    expect(classifyDoseReply(text)).toBe(expected);
  });

  it("yes/no and counts", () => {
    expect(classifyYesNo("Yes, that's right")).toBe("yes");
    expect(classifyYesNo("no")).toBe("no");
    expect(classifyYesNo("I think so")).toBe("unclear");
    expect(extractPillCount("I only have two pills left")).toBe(2);
    expect(extractPillCount("2 or 3 maybe")).toBeNull();
  });

  it("flags overdose, wrong dose and symptoms", () => {
    expect(detectMedicationConcern("I think I took two doses by accident")).toMatchObject({ kind: "possible_overdose", urgent: true });
    expect(detectMedicationConcern("I took my evening pill instead of the morning one")?.kind).toBe("possible_wrong_dose");
    expect(detectMedicationConcern("I have chest pain")).toMatchObject({ kind: "symptoms", urgent: true });
    expect(detectMedicationConcern("I feel a bit dizzy")).toMatchObject({ kind: "symptoms", urgent: false });
    expect(detectMedicationConcern("I took it")).toBeNull();
  });
});

describe("supply and refill thresholds", () => {
  it("decrements once per confirmed dose (idempotent)", () => {
    const m = med({ pillsRemaining: 10, pillsPerDose: 2 });
    const c = confirmDose(dose(m), m, yes, dose(m).scheduledAt);
    if (c.kind !== "confirmed") throw new Error();
    const a = applyDoseToSupply(m, c.dose, 1, "u");
    expect(a.med.pillsRemaining).toBe(8);
    const b = applyDoseToSupply(a.med, a.dose, 2, "u");
    expect(b.changed).toBe(false);
    expect(b.med.pillsRemaining).toBe(8);
  });

  it("never decrements an unconfirmed dose", () => {
    const m = med();
    expect(applyDoseToSupply(m, dose(m), 1, "u").changed).toBe(false);
  });

  it("days of supply and the refill trigger", () => {
    const twice = med({ schedule: [{ slot: "morning", time: "08:00" }, { slot: "evening", time: "20:00" }], pillsRemaining: 11 });
    expect(daysOfSupply(twice)).toBe(5);
    expect(needsRefill(twice)).toBe(true);
    expect(needsRefill(med({ pillsRemaining: 6 }))).toBe(false);
    expect(needsRefill(med({ pillsRemaining: 5 }))).toBe(true);
    expect(needsRefill(med({ pillsRemaining: 0, active: false }))).toBe(false);
  });

  it("a confirmed user count replaces the estimate, with history", () => {
    const m = setReportedCount(med({ pillsRemaining: 6 }), 2, 5, "user");
    expect(m.pillsRemaining).toBe(2);
    expect(m.supplyHistory.at(-1)).toMatchObject({ change: -4, resultingCount: 2 });
    expect(() => setReportedCount(m, -1, 5, "user")).toThrow();
  });
});

describe("missed-dose escalation", () => {
  const m = med({ schedule: [{ slot: "morning", time: "08:00" }, { slot: "evening", time: "20:00" }] });
  const missedOn = (date: string, idx = 0) => {
    const d = dosesForDate(m, date)[idx];
    return run(d, m, d.windowEnd + 1);
  };

  it("alerts after two missed doses within three days", () => {
    const one = [missedOn("2026-10-24")];
    expect(evaluateMissedDoseEscalation(one, one[0].windowEnd + MIN, new Set())).toBeNull();
    const two = [...one, missedOn("2026-10-25", 1)];
    const ids = evaluateMissedDoseEscalation(two, two[1].windowEnd + MIN, new Set());
    expect(ids).toHaveLength(2);
    // Already alerted on both → no duplicate alert.
    expect(evaluateMissedDoseEscalation(two, two[1].windowEnd + MIN, new Set(ids!))).toBeNull();
  });

  it("ignores misses older than the window and late-confirmed doses", () => {
    const old = missedOn("2026-10-20");
    const recent = missedOn("2026-10-25");
    const now = recent.windowEnd + MIN;
    expect(evaluateMissedDoseEscalation([old, recent], now, new Set())).toBeNull();
    const late = confirmDose(missedOn("2026-10-25", 1), m, yes, missedOn("2026-10-25", 1).windowEnd + 60 * MIN);
    if (late.kind !== "confirmed") throw new Error();
    expect(evaluateMissedDoseEscalation([recent, late.dose], now + DAY / 2, new Set())).toBeNull();
  });

  it("honours a configured rule", () => {
    const one = [missedOn("2026-10-25")];
    expect(evaluateMissedDoseEscalation(one, one[0].windowEnd + MIN, new Set(), { missedDoses: 1, withinDays: 1 })).toHaveLength(1);
  });
});
