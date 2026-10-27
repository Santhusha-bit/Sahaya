import { hashValue, newId } from "@/lib/ids";
import { AgentError, isAgentError, toErrorMessage } from "../../base/errors";
import { EVENT_TYPES } from "../../contracts";
import { resolveAdapter } from "../adapters";
import { classifyDoseReply, classifyYesNo, detectMedicationConcern, type MedicationConcern } from "../domain/language";
import {
  DEFAULT_ESCALATION,
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
  relevantDates,
  restoreDoseSupply,
  setReportedCount,
  type DoseRecord,
  type Medication,
  type ScheduledTime,
} from "../domain/medication";
import { isValidTimeZone, localDateOf, parseClockTime } from "../domain/time";
import { sanitizeUntrusted } from "../domain/untrusted";
import { NS, type CareAlert, type PendingConfirmation, type RefillRecord, type RefillStatus } from "../repository";
import type { CareEnv } from "./env";

/** Neutral line for any missed-dose question. Never advice to take, skip, delay or double. */
export const MISSED_DOSE_GUIDANCE = "Please check the label or ask your pharmacist what to do.";

const OPEN_REFILL: RefillStatus[] = ["draft", "blocked", "submitted", "ready"];

export interface TickReport {
  transitions: Array<{ doseId: string; action: string }>;
  prompts: string[];
  alerts: string[];
  refills: string[];
}

export class MedicationService {
  constructor(private readonly env: CareEnv) {}

  private get repo() {
    return this.env.repo;
  }

  private async name(userId: string) {
    return (await this.repo.profile(userId))?.displayName || "there";
  }

  /** Create dose records for yesterday/today/tomorrow (idempotent: existing records are never rebuilt). */
  /** Materialises today's dose records. `persist: false` (caregiver views) computes them without writing. */
  async ensureDoses(userId: string, opts: { persist?: boolean } = {}): Promise<DoseRecord[]> {
    const persist = opts.persist ?? true;
    const now = this.env.now();
    const existing = new Map((await this.repo.doses(userId)).map((d) => [d.id, d]));
    for (const med of await this.repo.medications(userId)) {
      if (!med.active) continue;
      for (const date of relevantDates(med, now)) {
        for (const d of dosesForDate(med, date)) {
          // Doses scheduled before the medication was entered were never tracked; don't invent misses.
          if (d.scheduledAt < med.scheduleSource.at) continue;
          if (!existing.has(d.id)) {
            if (persist) await this.repo.saveDose(userId, d);
            existing.set(d.id, d);
          }
        }
      }
    }
    return [...existing.values()].sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  /** Advance every dose's timers once, send the matching prompts, then run escalation and refill checks. */
  async tick(userId: string): Promise<TickReport> {
    const now = this.env.now();
    const report: TickReport = { transitions: [], prompts: [], alerts: [], refills: [] };
    const doses = await this.ensureDoses(userId);
    const meds = new Map((await this.repo.medications(userId)).map((m) => [m.id, m]));
    const who = await this.name(userId);
    for (let dose of doses) {
      const med = meds.get(dose.medicationId);
      if (!med) continue;
      for (let action = dueTimer(dose, med, now); action; action = dueTimer(dose, med, now)) {
        dose = applyTimer(dose, action, now);
        await this.repo.saveDose(userId, dose);
        report.transitions.push({ doseId: dose.id, action });
        const prompt = promptFor(action, who, dose.slot);
        if (prompt) {
          await this.voice().say(userId, prompt, `medication_${action}`, dose.id);
          report.prompts.push(prompt);
        }
        await this.env.audit(userId, "schedule", `Dose ${action}`, { doseId: dose.id, state: dose.state });
      }
    }
    const alert = await this.evaluateEscalation(userId);
    if (alert) report.alerts.push(alert.id);
    for (const med of meds.values()) {
      const r = await this.checkRefill(userId, med.id);
      if (r) report.refills.push(r.id);
    }
    await this.syncRefills(userId);
    return report;
  }

  private voice() {
    return resolveAdapter(this.env.adapters.voice, this.env.integrationMode);
  }

  /** Send (or repeat) the reminder for a specific dose today. Never marks anything taken. */
  async sendReminder(userId: string, medicationId: string, doseTime: string) {
    const med = await this.repo.medication(userId, medicationId);
    const now = this.env.now();
    const today = localDateOf(now, med.timeZone);
    const doses = await this.ensureDoses(userId);
    let dose = doses.find((d) => d.medicationId === med.id && d.localDate === today && d.scheduledTime === doseTime);
    if (!dose) throw new AgentError("NOT_FOUND", `no ${doseTime} dose scheduled today for this medication`);
    if (dose.state === "confirmed") return { status: "already_confirmed", doseId: dose.id };
    if (dose.state === "missed") return { status: "window_closed", doseId: dose.id, message: MISSED_DOSE_GUIDANCE };
    if (now < dose.windowStart) throw new DoseTransitionError("NOT_DUE", "this dose isn't due yet");
    if (dose.state === "scheduled") {
      dose = applyTimer(dose, "remind", now);
      await this.repo.saveDose(userId, dose);
    }
    const text = promptFor("remind", await this.name(userId), dose.slot)!;
    await this.voice().say(userId, text, "medication_remind", dose.id);
    return { status: dose.state, doseId: dose.id, said: text, simulatedVoice: true };
  }

  /** The dose a reply or confirmation refers to: the most recent one whose window has opened. */
  private async targetDose(userId: string, medicationId?: string, doseId?: string) {
    const now = this.env.now();
    const doses = await this.ensureDoses(userId);
    if (doseId) {
      const d = doses.find((x) => x.id === doseId);
      if (!d) throw new AgentError("NOT_FOUND", "dose not found");
      return d;
    }
    const meds = new Map((await this.repo.medications(userId)).map((m) => [m.id, m]));
    const lateMs = (d: DoseRecord) => (meds.get(d.medicationId)?.rules.lateConfirmationMaxMin ?? 0) * 60_000;
    // Doses that can be answered right now: window open, or closed but still within the late-confirmation limit.
    const answerable = doses
      .filter((d) => d.windowStart <= now && now <= d.windowEnd + lateMs(d))
      .sort((a, b) => b.scheduledAt - a.scheduledAt);
    if (!medicationId) {
      // Without a medication, only unambiguous when exactly one dose is awaiting an answer
      // (or, for a repeat "I took it", exactly one dose whose window is open right now).
      const awaiting = answerable.filter((d) => ["reminded", "unconfirmed", "checked_in"].includes(d.state));
      if (awaiting.length === 1) return awaiting[0];
      if (awaiting.length > 1) throw new AgentError("VALIDATION_FAILED", "more than one dose is waiting; say which medication");
      const open = answerable.filter((d) => now <= d.windowEnd);
      if (open.length === 1) return open[0];
      if (meds.size === 1) medicationId = [...meds.keys()][0];
      else throw new AgentError("VALIDATION_FAILED", "say which medication this is about");
    }
    const mine = answerable.filter((d) => d.medicationId === medicationId);
    if (mine.length) return mine[0];
    if (doses.some((d) => d.medicationId === medicationId && d.windowStart > now)) {
      throw new DoseTransitionError("NOT_DUE", "this dose is not due yet, so it can't be confirmed");
    }
    throw new DoseTransitionError("TOO_LATE", "that dose is too far in the past to record as taken");
  }

  /**
   * Record an explicit "I took it". `explicit` must be true; callers only set it after a deterministic
   * check of the user's own words (classifyDoseReply) or an explicit tap by the user.
   */
  async confirm(
    userId: string,
    actorId: string,
    opts: { medicationId?: string; doseId?: string; via: "voice" | "text" | "dashboard"; explicit: boolean },
  ) {
    const dose = await this.targetDose(userId, opts.medicationId, opts.doseId);
    const med = await this.repo.medication(userId, dose.medicationId);
    const outcome = confirmDose(dose, med, { explicit: opts.explicit, by: actorId, via: opts.via }, this.env.now());
    if (outcome.kind === "duplicate") {
      await this.env.audit(userId, "tool_result", "Duplicate dose confirmation ignored", { doseId: dose.id });
      return { status: "already_confirmed" as const, doseId: dose.id, pillsRemaining: med.pillsRemaining, message: "That dose is already recorded as taken." };
    }
    const applied = applyDoseToSupply(med, outcome.dose, this.env.now(), actorId);
    await this.repo.saveDose(userId, applied.dose);
    await this.repo.saveMedication(userId, applied.med);
    await this.env.audit(userId, "tool_result", outcome.late ? "Dose confirmed late" : "Dose confirmed", {
      doseId: dose.id,
      by: actorId,
      late: outcome.late,
    });
    const refill = await this.checkRefill(userId, med.id);
    return {
      status: outcome.late ? ("confirmed_late" as const) : ("confirmed" as const),
      doseId: dose.id,
      pillsRemaining: applied.med.pillsRemaining,
      daysOfSupply: daysOfSupply(applied.med),
      refillDraftId: refill?.id,
      message: outcome.late ? "Thanks — I've noted that you took it, later than scheduled." : "Thank you — I've noted that you took it.",
    };
  }

  /**
   * Handle a spoken/typed answer to a reminder or check-in. Safety concerns are checked first; only an
   * explicit "I took it" confirms; everything else is recorded as-is without guessing.
   */
  async handleReply(userId: string, actorId: string, transcript: string, opts: { medicationId?: string; via: "voice" | "text" }) {
    await this.voice().heard(userId, transcript, "medication_reply");
    const concern = detectMedicationConcern(transcript);
    if (concern) return { kind: "concern" as const, ...(await this.reportConcern(userId, concern.kind, concern.urgent)) };
    const reply = classifyDoseReply(transcript);
    if (reply === "taken") {
      const res = await this.confirm(userId, actorId, { medicationId: opts.medicationId, via: opts.via, explicit: true });
      await this.voice().say(userId, res.message, "medication_ack", res.doseId);
      return { kind: "confirmation" as const, reply, ...res };
    }
    const dose = await this.targetDose(userId, opts.medicationId);
    const next = recordCheckInResponse(dose, reply, this.env.now(), actorId);
    await this.repo.saveDose(userId, next);
    await this.env.audit(userId, "tool_result", "Check-in response recorded", { doseId: dose.id, response: reply });
    const message =
      reply === "not_taken"
        ? `Thanks for telling me. I haven't marked it as taken. ${MISSED_DOSE_GUIDANCE} Let me know if you take it.`
        : reply === "unsure"
          ? `That's okay. I haven't marked it as taken. ${MISSED_DOSE_GUIDANCE}`
          : "I didn't catch an answer, so I haven't marked anything.";
    await this.voice().say(userId, message, "medication_ack", dose.id);
    return { kind: "recorded" as const, reply, doseId: dose.id, state: next.state, message };
  }

  async correct(userId: string, actorId: string, doseId: string, note: string) {
    const dose = await this.targetDose(userId, undefined, doseId);
    const med = await this.repo.medication(userId, dose.medicationId);
    const corrected = correctConfirmation(dose, this.env.now(), actorId, note);
    const restored = restoreDoseSupply(med, corrected, this.env.now(), actorId);
    await this.repo.saveDose(userId, restored.dose);
    await this.repo.saveMedication(userId, restored.med);
    await this.env.audit(userId, "tool_result", "Dose confirmation corrected", { doseId, by: actorId });
    return { doseId, state: restored.dose.state, pillsRemaining: restored.med.pillsRemaining };
  }

  // ── Supply ──────────────────────────────────────────────────────────────

  /** Step 1: the user reports a count. Nothing changes until they confirm the medication and number. */
  async reportPillCount(userId: string, medicationId: string, count: number) {
    if (!Number.isInteger(count) || count < 0 || count > 2000) throw new AgentError("VALIDATION_FAILED", "count must be a whole number");
    const med = await this.repo.medication(userId, medicationId);
    const now = this.env.now();
    const pending: PendingConfirmation = {
      id: newId("pend"),
      kind: "pill_count",
      medicationId,
      count,
      question: `Just to check: you have ${count} ${count === 1 ? "tablet" : "tablets"} of ${med.name} left. Is that right?`,
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
      status: "pending",
    };
    await this.repo.put(userId, NS.pending, pending.id, pending, "Pending pill count confirmation");
    return { pendingId: pending.id, question: pending.question };
  }

  /** Step 2: an explicit yes applies the count as the new estimate; anything else changes nothing. */
  async confirmPillCount(userId: string, actorId: string, pendingId: string, answer: string) {
    const pending = await this.repo.require<PendingConfirmation>(userId, NS.pending, pendingId, "pending confirmation");
    if (pending.kind !== "pill_count" || pending.status !== "pending") {
      throw new AgentError("VALIDATION_FAILED", `this confirmation is ${pending.status}`);
    }
    if (pending.expiresAt < this.env.now()) {
      await this.repo.put(userId, NS.pending, pendingId, { ...pending, status: "expired" }, "");
      throw new AgentError("VALIDATION_FAILED", "that count confirmation expired; please report the count again");
    }
    const yn = classifyYesNo(answer);
    if (yn !== "yes") {
      await this.repo.put(userId, NS.pending, pendingId, { ...pending, status: yn === "no" ? "declined" : "pending" }, "");
      return { applied: false, message: yn === "no" ? "Okay, I haven't changed the count." : "Sorry, was that a yes or a no?" };
    }
    const med = await this.repo.medication(userId, pending.medicationId!);
    const updated = setReportedCount(med, pending.count!, this.env.now(), actorId);
    await this.repo.saveMedication(userId, updated);
    await this.repo.put(userId, NS.pending, pendingId, { ...pending, status: "confirmed" }, "");
    await this.env.audit(userId, "tool_result", "Supply estimate set from confirmed user count", { medicationId: med.id });
    const refill = await this.checkRefill(userId, med.id);
    return {
      applied: true,
      pillsRemaining: updated.pillsRemaining,
      daysOfSupply: daysOfSupply(updated),
      refillNeeded: needsRefill(updated),
      refillDraftId: refill?.id,
      message: `Thanks. I've updated your supply to ${updated.pillsRemaining}.`,
    };
  }

  // ── Refills ─────────────────────────────────────────────────────────────

  /** If supply is at/below the lead time and no refill is open, prepare a draft and alert. Idempotent. */
  async checkRefill(userId: string, medicationId: string): Promise<RefillRecord | null> {
    const med = await this.repo.medication(userId, medicationId);
    if (!needsRefill(med)) return null;
    const open = (await this.repo.refills(userId)).find((r) => r.medicationId === med.id && OPEN_REFILL.includes(r.status));
    if (open) return null;
    const draft = await this.prepareDraft(userId, med.id, "pickup");
    await this.raiseAlert(userId, {
      kind: draft.status === "draft" ? "refill_needed" : "refill_problem",
      area: "medications",
      severity: draft.status === "draft" ? "attention" : "urgent",
      title: draft.status === "draft" ? `Refill needed: ${med.name}` : `Refill needs help: ${med.name}`,
      detail:
        draft.status === "draft"
          ? `About ${daysOfSupply(med)} day(s) of supply left. A refill draft is ready for review.`
          : `A refill can't be prepared: ${draft.missing.length ? `missing ${draft.missing.join(", ")}` : "no refills remaining"}.`,
      relatedIds: [med.id, draft.id],
    });
    return draft;
  }

  /** Build a refill draft strictly from stored data. Missing fields are listed, never invented. */
  async prepareDraft(userId: string, medicationId: string, fulfillment: "pickup" | "delivery"): Promise<RefillRecord> {
    const med = await this.repo.medication(userId, medicationId);
    const existing = (await this.repo.refills(userId)).find(
      (r) => r.medicationId === med.id && (r.status === "draft" || r.status === "blocked") && r.fulfillment === fulfillment,
    );
    if (existing) return existing;
    const missing: string[] = [];
    if (!med.rxNumber) missing.push("prescription number");
    if (!med.pharmacy) missing.push("pharmacy");
    if (!med.lastFill?.quantity) missing.push("quantity (no previous fill on record)");
    const noRefills = med.refillsRemaining === 0;
    const now = this.env.now();
    const fields = {
      medicationId: med.id,
      quantity: med.lastFill?.quantity ?? null,
      rxNumber: med.rxNumber ?? null,
      pharmacyId: med.pharmacy?.id ?? null,
      fulfillment,
    };
    const status: RefillStatus = missing.length ? "blocked" : noRefills ? "no_refills_remaining" : "draft";
    const record: RefillRecord = {
      id: newId("refill"),
      medicationId: med.id,
      medicationName: med.name,
      quantity: fields.quantity,
      rxNumber: fields.rxNumber,
      pharmacy: med.pharmacy ? { id: med.pharmacy.id, name: med.pharmacy.name } : null,
      lastFill: med.lastFill ?? null,
      refillsRemaining: med.refillsRemaining ?? null,
      fulfillment,
      missing,
      status,
      draftHash: hashValue(fields),
      createdAt: now,
      updatedAt: now,
      pharmacyMessages: [],
      statusHistory: [{ at: now, status }],
      simulated: true,
      demo: med.demo,
    };
    await this.repo.saveRefill(userId, record);
    await this.env.audit(userId, "tool_result", "Refill draft prepared", { refillId: record.id, status });
    return record;
  }

  /** Exact input the approval must bind to (see careTools.submitPharmacyRefill). */
  static submissionInput(r: RefillRecord) {
    return {
      refillId: r.id,
      medicationId: r.medicationId,
      quantity: r.quantity ?? 0,
      rxNumber: r.rxNumber ?? "",
      pharmacyId: r.pharmacy?.id ?? "",
      fulfillment: r.fulfillment,
      draftHash: r.draftHash,
    };
  }

  /** Server-side checks that the approved draft is still exactly what's stored and submittable. */
  async verifySubmission(userId: string, input: ReturnType<typeof MedicationService.submissionInput>) {
    const r = await this.repo.require<RefillRecord>(userId, NS.refills, input.refillId, "refill draft");
    if (r.status !== "draft") throw new AgentError("VALIDATION_FAILED", `refill is ${r.status}, not a submittable draft`);
    const expected = MedicationService.submissionInput(r);
    if (hashValue(expected) !== hashValue(input)) {
      throw new AgentError("APPROVAL_INVALID", "refill details differ from the stored draft");
    }
    const med = await this.repo.medication(userId, r.medicationId);
    const recomputed = hashValue({
      medicationId: med.id,
      quantity: med.lastFill?.quantity ?? null,
      rxNumber: med.rxNumber ?? null,
      pharmacyId: med.pharmacy?.id ?? null,
      fulfillment: r.fulfillment,
    });
    if (recomputed !== r.draftHash) throw new AgentError("VALIDATION_FAILED", "prescription details changed since the draft; prepare a new draft");
    return r;
  }

  /** Runs only after server-side approval verification in the ToolRegistry. */
  async submit(userId: string, input: ReturnType<typeof MedicationService.submissionInput>) {
    const r = await this.verifySubmission(userId, input);
    const pharmacy = resolveAdapter(this.env.adapters.pharmacy, this.env.integrationMode);
    const res = await pharmacy.submitRefill(userId, {
      idempotencyKey: r.id,
      rxNumber: input.rxNumber,
      medicationName: r.medicationName,
      quantity: input.quantity,
      pharmacyId: input.pharmacyId,
      fulfillment: input.fulfillment,
    });
    const now = this.env.now();
    const updated: RefillRecord = {
      ...r,
      status: res.status,
      submittedAt: now,
      updatedAt: now,
      pharmacyRequestId: res.requestId,
      pharmacyMessages: [...r.pharmacyMessages, { at: now, text: res.message.text, flagged: res.message.flagged }],
      statusHistory: [...r.statusHistory, { at: now, status: res.status }],
    };
    await this.repo.saveRefill(userId, updated);
    await this.env.audit(userId, "tool_result", "Refill submitted to sandbox pharmacy", { refillId: r.id, status: res.status, simulated: true });
    if (res.status !== "submitted" && res.status !== "ready") await this.refillProblemAlert(userId, updated);
    return {
      refillId: r.id,
      status: res.status,
      simulated: true,
      note: "Sandbox pharmacy only — no prescription was sent to a real pharmacy.",
      pharmacyMessage: res.message,
    };
  }

  private async refillProblemAlert(userId: string, r: RefillRecord) {
    const why: Record<string, string> = {
      rejected: "The pharmacy rejected the request.",
      out_of_stock: "The pharmacy reports the medication is out of stock.",
      no_refills_remaining: "No refills remain; the prescriber needs to authorize more.",
    };
    await this.raiseAlert(userId, {
      kind: "refill_problem",
      area: "medications",
      severity: "urgent",
      title: `Refill needs attention: ${r.medicationName}`,
      detail: `${why[r.status] ?? "The refill could not be completed."} (sandbox)`,
      relatedIds: [r.medicationId, r.id],
    });
  }

  /** Pull simulated status changes (submitted → ready) and alert on problems. */
  async syncRefills(userId: string) {
    const pharmacy = this.env.adapters.pharmacy;
    for (const r of await this.repo.refills(userId)) {
      if (!r.pharmacyRequestId || !(r.status === "submitted" || r.status === "ready")) continue;
      const view = await pharmacy.getStatus(userId, r.pharmacyRequestId);
      if (view.status === r.status) continue;
      const now = this.env.now();
      const updated: RefillRecord = { ...r, status: view.status, updatedAt: now, statusHistory: [...r.statusHistory, { at: now, status: view.status }] };
      await this.repo.saveRefill(userId, updated);
      await this.env.audit(userId, "tool_result", "Refill status changed", { refillId: r.id, status: view.status, simulated: true });
      if (["rejected", "out_of_stock", "no_refills_remaining"].includes(view.status)) await this.refillProblemAlert(userId, updated);
    }
  }

  async markPickedUp(userId: string, actorId: string, refillId: string) {
    await this.syncRefills(userId);
    const r = await this.repo.require<RefillRecord>(userId, NS.refills, refillId, "refill");
    if (r.status === "picked_up") return { refillId, status: r.status, duplicate: true };
    if (!r.pharmacyRequestId) throw new AgentError("VALIDATION_FAILED", "this refill was never submitted");
    const view = await this.env.adapters.pharmacy.markPickedUp(userId, r.pharmacyRequestId);
    const now = this.env.now();
    const med = await this.repo.medication(userId, r.medicationId);
    const qty = r.quantity ?? 0;
    const updatedMed: Medication = {
      ...med,
      pillsRemaining: med.pillsRemaining + qty,
      lastFill: { date: localDateOf(now, med.timeZone), quantity: qty },
      refillsRemaining: med.refillsRemaining === undefined ? undefined : Math.max(0, med.refillsRemaining - 1),
      supplyHistory: [
        ...med.supplyHistory,
        { at: now, change: qty, reason: `refill ${r.id} picked up (estimate)`, resultingCount: med.pillsRemaining + qty, by: actorId },
      ],
    };
    await this.repo.saveMedication(userId, updatedMed);
    await this.repo.saveRefill(userId, { ...r, status: view.status, updatedAt: now, statusHistory: [...r.statusHistory, { at: now, status: view.status }] });
    await this.env.audit(userId, "tool_result", "Refill picked up", { refillId, simulated: true });
    return { refillId, status: view.status, pillsRemaining: updatedMed.pillsRemaining, duplicate: false };
  }

  // ── Safety ──────────────────────────────────────────────────────────────

  /**
   * Possible overdose / wrong dose / symptoms: give the safe fixed response, alert the caregiver, and
   * (when urgent or a dosing problem) escalate through Guardian's existing workflow via the event bus.
   */
  async reportConcern(userId: string, kind: MedicationConcern, urgent: boolean) {
    const now = this.env.now();
    const alert = await this.raiseAlert(userId, {
      kind: "medication_safety",
      area: "medications",
      severity: urgent || kind !== "symptoms" ? "urgent" : "attention",
      title: kind === "possible_overdose" ? "Possible medication overdose reported" : kind === "possible_wrong_dose" ? "Possible wrong medication or dose reported" : "Symptoms reported",
      detail: "Care advised contacting a pharmacist, doctor, or emergency services. Care does not assess symptoms or doses.",
      relatedIds: [],
    });
    let escalation: { status: string; eventId?: string } = { status: "not_needed" };
    if (urgent || kind !== "symptoms") {
      try {
        const event = await this.env.emit("guardian", EVENT_TYPES.safetyConcern, {
          severity: urgent ? "urgent" : "high",
          category: "medical",
          summary:
            kind === "possible_overdose"
              ? "User reported possibly taking too much medication. Care advised calling emergency services or Poison Control."
              : kind === "possible_wrong_dose"
                ? "User reported a possible wrong medication or dose. Care advised calling a pharmacist or doctor."
                : "User reported urgent symptoms. Care advised calling emergency services.",
          observedAt: now,
        });
        escalation = { status: event.status, eventId: event.id };
      } catch (err) {
        escalation = { status: isAgentError(err) && err.code === "CONSENT_REQUIRED" ? "route_disabled" : `failed: ${toErrorMessage(err)}` };
      }
      await this.repo.saveAlert(userId, { ...alert, escalationEventId: escalation.eventId, escalationStatus: escalation.status });
    }
    const message =
      kind === "possible_overdose" || urgent
        ? "This could be serious. If you feel unwell or think you took too much, call 911 or your local emergency number now. You can also call Poison Control at 1-800-222-1222. I've added an urgent alert for your caregiver."
        : kind === "possible_wrong_dose"
          ? "Please call your pharmacist or doctor now and tell them what you took. If you start to feel unwell, call 911. I've added an alert for your caregiver."
          : "I'm sorry you're not feeling well. I can't assess symptoms or side effects. Please call your pharmacist or doctor. If it gets worse or feels urgent, call 911.";
    await this.voice().say(userId, message, "medication_safety");
    return { alertId: alert.id, escalation, message };
  }

  // ── Escalation + alerts ─────────────────────────────────────────────────

  async evaluateEscalation(userId: string): Promise<CareAlert | null> {
    const profile = await this.repo.profile(userId);
    const alerts = await this.repo.alerts(userId);
    const alerted = new Set(alerts.filter((a) => a.kind === "missed_doses").flatMap((a) => a.relatedIds));
    const doses = await this.repo.doses(userId);
    const ids = evaluateMissedDoseEscalation(doses, this.env.now(), alerted, profile?.escalation ?? DEFAULT_ESCALATION);
    if (!ids) return null;
    const rule = profile?.escalation ?? DEFAULT_ESCALATION;
    return this.raiseAlert(userId, {
      kind: "missed_doses",
      area: "medications",
      severity: "attention",
      title: `${ids.length} missed doses in the last ${rule.withinDays} days`,
      detail: "Doses were not confirmed within their window. This alert doesn't mean they weren't taken — only that no one confirmed them.",
      relatedIds: ids,
    });
  }

  async raiseAlert(userId: string, a: Omit<CareAlert, "id" | "createdAt" | "demo">): Promise<CareAlert> {
    const profile = await this.repo.profile(userId);
    const alert: CareAlert = { ...a, id: newId("alert"), createdAt: this.env.now(), demo: profile?.isDemo ?? false };
    await this.repo.saveAlert(userId, alert);
    await this.env.audit(userId, "lifecycle", `Caregiver alert raised (${a.kind})`, { alertId: alert.id, severity: a.severity });
    return alert;
  }

  // ── Schedule changes (approval-gated by the tool) ───────────────────────

  async changeSchedule(userId: string, actorId: string, input: { medicationId: string; schedule: ScheduledTime[]; timeZone?: string }, approvalId?: string) {
    const med = await this.repo.medication(userId, input.medicationId);
    const slots = new Set<string>();
    for (const s of input.schedule) {
      parseClockTime(s.time);
      if (slots.has(s.slot)) throw new AgentError("VALIDATION_FAILED", `duplicate slot ${s.slot}`);
      slots.add(s.slot);
    }
    if (input.timeZone && !isValidTimeZone(input.timeZone)) throw new AgentError("VALIDATION_FAILED", "unknown time zone");
    const now = this.env.now();
    const updated: Medication = {
      ...med,
      schedule: input.schedule,
      timeZone: input.timeZone ?? med.timeZone,
      scheduleHistory: [...med.scheduleHistory, { at: now, by: actorId, approvalId, from: med.schedule, to: input.schedule, source: "prescription_label" }],
    };
    await this.repo.saveMedication(userId, updated);
    // Future doses that haven't started are rebuilt from the new schedule; past/started ones keep their history.
    for (const d of await this.repo.doses(userId)) {
      if (d.medicationId === med.id && d.state === "scheduled" && d.windowStart > now) await this.repo.delete(userId, NS.doses, d.id);
    }
    await this.ensureDoses(userId);
    await this.env.audit(userId, "approval", "Medication schedule changed", { medicationId: med.id, approvalId, by: actorId, slots: input.schedule.length });
    return { medicationId: med.id, schedule: updated.schedule, timeZone: updated.timeZone };
  }

  /** For the agent/LLM: wrap pharmacy text as untrusted data. */
  static pharmacyNote(text: string) {
    return sanitizeUntrusted(text, "pharmacy");
  }
}

function promptFor(action: string, who: string, slot: string): string | null {
  switch (action) {
    case "remind":
      return `${who}, it's time for your ${slot} medication. Have you taken it?`;
    case "follow_up":
      return `${who}, just checking in. Have you taken your ${slot} medication yet?`;
    case "start_check_in":
      return `Hi ${who}, it's Care. I haven't heard back about your ${slot} medication. Have you taken it?`;
    default:
      return null;
  }
}
