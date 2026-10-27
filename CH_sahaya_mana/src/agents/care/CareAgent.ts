import { hashValue, newId } from "@/lib/ids";
import { BaseAgent, type AgentDefinition, type AgentDeps } from "../base/BaseAgent";
import { AgentError } from "../base/errors";
import { DEFAULT_POLICY } from "../base/policy";
import type { ToolExecutionResult } from "../base/ToolRegistry";
import type { AgentContext, AgentEvent, ApprovalRequest, ScheduledJob } from "../base/types";
import {
  EVENT_TYPES,
  mealAssistancePayload,
  paymentReviewPayload,
  physicalAssistancePayload,
  safetyConcernPayload,
} from "../contracts";
import { describeAdapters } from "./adapters";
import { CARE_PROMPT } from "./carePrompt";
import { careServices, careTools, refillApprovalInput } from "./careTools";
import { seedDemoCareData } from "./data/demoProfile";
import { detectCookingDifficulty, parseCookingCommand } from "./domain/language";
import { adherenceSummary, daysOfSupply } from "./domain/medication";
import { cartTotals, fmt } from "./domain/grocery";
import { recipeById } from "./data/recipes";
import { speakStep } from "./domain/meals";
import { friendlyDateTime, friendlyTime, localDateOf } from "./domain/time";
import { APPROVAL_AREAS, canAccessCare, type CareArea } from "./permissions";
import { CARE_NAMESPACES, NS, type HelpRequestRecord, type MealPlanRecord } from "./repository";
import { KIND_AREA, KIND_LABEL } from "./memory/facts";
import { SERVICE_LABEL, classifyHomeService, detectEmergencies } from "./domain/homeServices";
import { guardHomeRepairReply } from "./domain/homeRepairReply";
import { HOME_SERVICES_SCOPE, grantActive } from "./accessRules";

const HOME_TOOLS = new Set(["startHomeRepairRequest", "proposeHomeRepairBooking", "bookHomeRepair", "getHomeRepairBookings"]);

export const careDefinition: AgentDefinition = {
  id: "care",
  displayName: "Care",
  tagline: "Manage medications, groceries, and everyday care.",
  welcome: "Hello, I'm Care. I can remind you about medications, sort out groceries, and suggest easy meals. What do you need today?",
  systemPrompt: CARE_PROMPT,
  effort: "medium",
  memoryNamespaces: CARE_NAMESPACES,
  tools: careTools,
  policy: DEFAULT_POLICY,
  events: {
    outbound: [
      {
        type: EVENT_TYPES.physicalAssistance,
        target: "guardian",
        description: "Ask Guardian to coordinate in-person help (e.g. meals, medication pickup)",
        payload: physicalAssistancePayload,
      },
      {
        type: EVENT_TYPES.safetyConcern,
        target: "guardian",
        description: "Escalate a possible medication overdose, wrong dose or urgent symptoms to Guardian",
        payload: safetyConcernPayload,
      },
      {
        type: EVENT_TYPES.paymentReview,
        target: "finance",
        description: "Ask Finance to review a grocery order payment",
        payload: paymentReviewPayload,
      },
    ],
    inbound: [
      {
        type: EVENT_TYPES.mealAssistance,
        from: ["wellness"],
        description: "Wellness asks Care to help with meals or groceries",
        payload: mealAssistancePayload,
      },
    ],
  },
  workflows: [
    {
      id: "grocery_order",
      title: "Order usual groceries",
      description: "Preferences → cart → substitutions → review → approval → order → tracking",
      steps: [
        { description: "Build the personalized cart", toolName: "createGroceryList" },
        { description: "Confirm substitutions and essentials", toolName: "respondToCartSuggestion" },
        { description: "Review the order summary", toolName: "reviewCart" },
        { description: "Get approval and place the order", toolName: "requestOrderApproval" },
        { description: "Track delivery", toolName: "getOrderStatus" },
      ],
    },
    {
      id: "medication_refill",
      title: "Refill a prescription",
      description: "Prepare a draft from stored data, get approval, submit, track",
      steps: [
        { description: "Check medication supply", toolName: "getMedicationSchedule" },
        { description: "Prepare refill draft", toolName: "preparePharmacyRefill" },
        { description: "Submit after approval", toolName: "submitPharmacyRefill" },
        { description: "Track refill status", toolName: "getRefillStatus" },
      ],
    },
    {
      id: "home_repair",
      title: "Arrange a home repair",
      description: "Safety steps → time windows → approval card → booking after Approve → status",
      steps: [
        { description: "Safety steps and time windows", toolName: "startHomeRepairRequest" },
        { description: "Approval card for the chosen time", toolName: "proposeHomeRepairBooking" },
        { description: "Book after approval", toolName: "bookHomeRepair" },
        { description: "Track the visit", toolName: "getHomeRepairBookings" },
      ],
    },
    {
      id: "meal_support",
      title: "Help with meals",
      description: "Offer options and, with consent, ask Guardian to coordinate caregiver help",
      steps: [
        { description: "Offer support options", toolName: "offerMealSupport" },
        { description: "Send the consented help request", toolName: "requestPhysicalAssistance" },
      ],
    },
  ],
  suggestedCommands: [
    "I'm running out of groceries",
    "My kitchen sink is leaking",
    "I keep forgetting my medication",
    "What can I make for dinner?",
    "What do you know about me?",
  ],
  jobKinds: ["medication_reminder"],
};

type Role = AgentContext["actor"]["role"];

/**
 * The Care agent. Conversation goes through BaseAgent (Claude + tools); deterministic workflows
 * (scheduler ticks, voice replies, dashboard reads) are methods here that use the same services,
 * the same scoped store and the same tool registry for anything approval-gated.
 */
export class CareAgent extends BaseAgent {
  constructor(deps: AgentDeps) {
    super(careDefinition, deps);
  }

  private svc(ctx: AgentContext) {
    return careServices({
      store: this.store,
      now: this.deps.now,
      integrationMode: this.deps.integrationMode,
      emit: (target, type, payload) => this.deps.publish(target, type, payload, ctx),
      ctx,
    });
  }

  /**
   * Home repair: choosing a time (proposeHomeRepairBooking) immediately puts the approval card for bookHomeRepair on
   * the person's screen — the result returned is that pending approval. bookHomeRepair itself only books with a
   * consumed approval (ToolRegistry); without one it returns the existing pending approval or creates one.
   * Rejected approval attempts are audited.
   */
  override async executeTool(ctx: AgentContext, name: string, input: unknown, link: { taskId?: string; stepId?: string; approvalId?: string } = {}): Promise<ToolExecutionResult> {
    if (name === "proposeHomeRepairBooking") {
      const proposed = await super.executeTool(ctx, name, input, link);
      if (proposed.status !== "success") return proposed;
      const out = proposed.output as { proposalId: string; approvalInput: Record<string, unknown> };
      const asked = await super.executeTool(ctx, "bookHomeRepair", out.approvalInput, { taskId: link.taskId });
      if (asked.status === "approval_required") await this.svc(ctx).homeServices.markApprovalRequested(ctx.userId, out.proposalId, asked.approval.id);
      return asked;
    }
    if (name === "bookHomeRepair") {
      const s = this.svc(ctx);
      if (!link.approvalId) {
        const proposalId = (input as { proposalId?: unknown } | null)?.proposalId;
        const p = typeof proposalId === "string" ? await s.homeServices.proposal(ctx.userId, proposalId).catch(() => null) : null;
        if (p?.status === "approval_requested" && p.approvalId) {
          const existing = await this.store.getApproval(p.approvalId).catch(() => null);
          if (existing?.status === "pending" && existing.inputHash === hashValue(input)) return { status: "approval_required", approval: existing };
        }
        const result = await super.executeTool(ctx, name, input, link);
        if (result.status === "approval_required" && p) await s.homeServices.markApprovalRequested(ctx.userId, p.id, result.approval.id);
        return result;
      }
      const result = await super.executeTool(ctx, name, input, link);
      if (result.status === "error") await s.homeServices.auditRejected(ctx.userId, { approvalId: link.approvalId, code: result.code });
      return result;
    }
    return super.executeTool(ctx, name, input, link);
  }

  /** Server-side check of home-repair replies against the wording rules (guardianPrompt.ts → HOME_REPAIR_WORDING_RULES). */
  protected override async filterReply(ctx: AgentContext, userText: string, reply: string, toolNames: string[]): Promise<string> {
    const s = this.svc(ctx);
    const homeTurn =
      classifyHomeService(userText) !== null ||
      detectEmergencies(userText).length > 0 ||
      toolNames.some((t) => HOME_TOOLS.has(t)) ||
      (await s.homeServices.activeConversation(ctx.userId).catch(() => false));
    if (!homeTurn) return reply;
    const g = guardHomeRepairReply(reply, userText, { bookingConfirmed: await s.homeServices.hasConfirmedBooking(ctx.userId).catch(() => false) });
    if (g.removed || g.emergencyAdded) await this.log(ctx, "audit", "info", "Home repair reply adjusted to the wording rules", { removedSentences: g.removed, emergencyAdded: g.emergencyAdded });
    return g.text;
  }

  private assertSelf(ctx: AgentContext, what: string) {
    const ok = (ctx.actor.role === "older_adult" && ctx.actor.id === ctx.userId) || ctx.actor.role === "system";
    if (!ok) throw new AgentError("PERMISSION_DENIED", `only the user can ${what}`);
  }

  /** Seed the fictional demo persona's Care records. Never called for real users. */
  async seedDemo(ctx: AgentContext) {
    this.assertSelf(ctx, "seed demo data");
    const created = await seedDemoCareData(this.svc(ctx).env.repo, ctx.userId, this.deps.now(), "demo-seed (prescription label, fictional)");
    if (created) await this.log(ctx, "lifecycle", "info", "Seeded fictional demo Care profile");
    return created;
  }

  /** The name the person asked to be called, if they've told Care (never a default). */
  async displayName(ctx: AgentContext): Promise<string | null> {
    return (await this.svc(ctx).env.repo.profile(ctx.userId))?.displayName || null;
  }

  /** Targeted, per-topic memory and state for this turn (not the whole profile). */
  protected override async turnContext(ctx: AgentContext, text: string): Promise<string[]> {
    const blocks = [await this.svc(ctx).memory.contextFor(ctx, text)];
    const service = classifyHomeService(text);
    const emergencies = detectEmergencies(text);
    if (service || emergencies.length) {
      blocks.push(
        `<home_repair>${service ? `Looks like a home repair: ${SERVICE_LABEL[service]}.` : "Possible home emergency."}${emergencies.length ? ` Emergency signs: ${emergencies.join(", ")} — tell them to get out and call 911 or the utility first.` : ""} Follow the home-repair rules: safety steps first, offer to arrange it (startHomeRepairRequest gives the steps and times), ask which time suits.</home_repair>`,
      );
    }
    return blocks;
  }

  // ── Memory (dashboard) ───────────────────────────────────────────────────

  /** Saved memories the viewer may see: the person sees all; caregivers only areas they're granted. */
  async listMemories(ctx: AgentContext) {
    const facts = await this.svc(ctx).memory.list(ctx.userId);
    const visible = [];
    for (const f of facts) {
      const area = KIND_AREA[f.kind];
      const ok =
        ctx.actor.role === "older_adult" ? ctx.actor.id === ctx.userId : area === "profile" ? false : await canAccessCare(ctx, area, "view", this.deps.permissions);
      if (ok) visible.push(f);
    }
    return visible
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((f) => ({ id: f.id, kind: f.kind, label: KIND_LABEL[f.kind], value: f.value, status: f.status, safetyCritical: f.safetyCritical, via: f.source.via, updatedAt: f.updatedAt, evidence: f.evidence ?? null }));
  }

  async correctMemory(ctx: AgentContext, factId: string, value: string) {
    if (!(ctx.actor.role === "older_adult" && ctx.actor.id === ctx.userId)) throw new AgentError("PERMISSION_DENIED", "only the person can change their memories");
    return this.svc(ctx).memory.correctOnDashboard(ctx.userId, ctx.actor.id, factId, value);
  }

  async deleteMemory(ctx: AgentContext, factId: string) {
    if (!(ctx.actor.role === "older_adult" && ctx.actor.id === ctx.userId)) throw new AgentError("PERMISSION_DENIED", "only the person can delete their memories");
    return this.svc(ctx).memory.forget(ctx.userId, ctx.actor.id, factId, { via: "dashboard" });
  }

  // ── Scheduler ────────────────────────────────────────────────────────────

  protected override async onJob(job: ScheduledJob, ctx: AgentContext) {
    if (job.kind === "medication_reminder") {
      await this.tick(ctx);
      return;
    }
    return super.onJob(job, ctx);
  }

  /** One deterministic pass: dose timers + prompts, escalation, refill drafts/approvals, sandbox status. */
  async tick(ctx: AgentContext) {
    this.assertSelf(ctx, "run the scheduler");
    const s = this.svc(ctx);
    if (!(await s.env.repo.profile(ctx.userId))) return { transitions: [], prompts: [], alerts: [], refills: [], orders: [] };
    const report = await s.meds.tick(ctx.userId);
    await this.ensureRefillApprovals(ctx);
    const orders = await s.grocery.syncOrders(ctx.userId);
    const homeRepairs = (await s.homeServices.bookings(ctx.userId, true)).map((b) => ({ bookingId: b.id, status: b.status }));
    return { ...report, orders, homeRepairs };
  }

  /** Every submittable refill draft gets exactly one pending approval request (via the registry). */
  async ensureRefillApprovals(ctx: AgentContext): Promise<ApprovalRequest[]> {
    const s = this.svc(ctx);
    const pending = await this.store.listApprovals({ userId: ctx.userId, status: ["pending", "approved"] });
    const created: ApprovalRequest[] = [];
    for (const r of await s.env.repo.refills(ctx.userId)) {
      if (r.status !== "draft") continue;
      const covered = pending.some((a) => a.toolName === "submitPharmacyRefill" && (a.input as { refillId?: string }).refillId === r.id);
      if (covered) continue;
      const sys: AgentContext = { userId: ctx.userId, actor: { id: "agent:care", role: "system" }, correlationId: ctx.correlationId };
      const res = await this.executeTool(sys, "submitPharmacyRefill", refillApprovalInput(r));
      if (res.status === "approval_required") created.push(res.approval);
    }
    return created;
  }

  // ── Voice / quick actions (deterministic, no LLM) ────────────────────────

  /** A transcript answering a medication reminder or check-in. */
  async medicationVoiceReply(ctx: AgentContext, transcript: string, medicationId?: string) {
    this.assertSelf(ctx, "answer for themselves");
    const res = await this.svc(ctx).meds.handleReply(ctx.userId, ctx.actor.id, transcript, { medicationId, via: "voice" });
    await this.ensureRefillApprovals(ctx);
    return res;
  }

  /** "I've taken it" tapped by the user on their own dashboard: an explicit confirmation. */
  async confirmDoseByUser(ctx: AgentContext, doseId: string) {
    if (!(ctx.actor.role === "older_adult" && ctx.actor.id === ctx.userId)) {
      throw new AgentError("PERMISSION_DENIED", "only the user can confirm their own dose");
    }
    const res = await this.svc(ctx).meds.confirm(ctx.userId, ctx.actor.id, { doseId, via: "dashboard", explicit: true });
    await this.ensureRefillApprovals(ctx);
    return res;
  }

  async reportPillCount(ctx: AgentContext, medicationId: string, count: number) {
    this.assertSelf(ctx, "report a pill count");
    return this.svc(ctx).meds.reportPillCount(ctx.userId, medicationId, count);
  }

  async confirmPillCount(ctx: AgentContext, pendingId: string, answer: string) {
    this.assertSelf(ctx, "confirm a pill count");
    const res = await this.svc(ctx).meds.confirmPillCount(ctx.userId, ctx.actor.id, pendingId, answer);
    await this.ensureRefillApprovals(ctx);
    return res;
  }

  async markRefillPickedUp(ctx: AgentContext, refillId: string) {
    this.assertSelf(ctx, "record a pickup");
    return this.svc(ctx).meds.markPickedUp(ctx.userId, ctx.actor.id, refillId);
  }

  /** A cooking-time utterance: a step command, or a sign that cooking is getting hard. */
  async cookingVoice(ctx: AgentContext, transcript: string) {
    this.assertSelf(ctx, "talk to Care");
    const s = this.svc(ctx);
    await s.env.adapters.voice.heard(ctx.userId, transcript, "cooking_reply");
    if (detectCookingDifficulty(transcript)) {
      const opts = s.meals.mealSupportOptions();
      await s.env.adapters.voice.say(ctx.userId, opts.message, "meal_support");
      return { kind: "support_offered" as const, ...opts };
    }
    const cmd = parseCookingCommand(transcript);
    if (!cmd) return { kind: "unclear" as const, say: "Sorry, I didn't catch that. You can say next, repeat, slower, or simpler." };
    return { kind: "step" as const, ...(await s.meals.cookingCommand(ctx.userId, cmd)) };
  }

  // ── Caregiver-facing ─────────────────────────────────────────────────────

  async acknowledgeAlert(ctx: AgentContext, alertId: string) {
    const s = this.svc(ctx);
    const alert = (await s.env.repo.alerts(ctx.userId)).find((a) => a.id === alertId);
    if (!alert) throw new AgentError("NOT_FOUND", "alert not found");
    if (!(await canAccessCare(ctx, alert.area, "view", this.deps.permissions))) {
      throw new AgentError("PERMISSION_DENIED", "not authorized for this alert");
    }
    if (alert.acknowledgedAt) return alert;
    const updated = { ...alert, acknowledgedAt: this.deps.now(), acknowledgedBy: ctx.actor.id };
    await s.env.repo.saveAlert(ctx.userId, updated);
    await this.log(ctx, "lifecycle", "info", "Care alert acknowledged", { alertId, by: ctx.actor.id });
    return updated;
  }

  /** Scope-aware approval: caregivers need the area's approve scope; consent-type actions are user-only. */
  override async resolveApproval(ctx: AgentContext, approvalId: string, decision: "approve" | "deny") {
    const approval = await this.store.getApproval(approvalId);
    const rule = APPROVAL_AREAS[approval.toolName];
    if (ctx.actor.role === "caregiver") {
      if (!rule || rule.userOnly) throw new AgentError("PERMISSION_DENIED", "only the user can decide this request");
      if (!(await canAccessCare(ctx, rule.area, "approve", this.deps.permissions))) {
        throw new AgentError("PERMISSION_DENIED", `caregiver ${ctx.actor.id} may not approve ${rule.area} actions`);
      }
      const out = await super.resolveApproval(ctx, approvalId, decision);
      await this.log(ctx, "audit", "info", `Caregiver ${decision === "approve" ? "approved" : "declined"} a request`, {
        caregiver: ctx.actor.id,
        approvalId,
        tool: approval.toolName,
        area: rule.area,
      });
      return out;
    }
    const out = await super.resolveApproval(ctx, approvalId, decision);
    if (approval.toolName === "bookHomeRepair" && decision === "deny") {
      await this.svc(ctx).homeServices.decline(ctx.userId, (approval.input as { proposalId?: string }).proposalId ?? "");
    }
    return out;
  }

  private hasTool(name: string) {
    return careTools.some((t) => t.name === name);
  }

  /** View-only caregiver scope for home-repair bookings (never approve/change/decline). */
  private async canViewHomeServices(ctx: AgentContext) {
    const perm = await this.deps.permissions.getCaregiverPermission(ctx.userId, ctx.actor.id, "care");
    return grantActive(perm, Date.now()) && perm.canViewSummaries && (perm.scopes ?? []).includes(HOME_SERVICES_SCOPE);
  }

  // ── Inbound events ───────────────────────────────────────────────────────

  protected override async onEvent(event: AgentEvent, ctx: AgentContext): Promise<{ taskId?: string } | void> {
    if (event.type !== EVENT_TYPES.mealAssistance) return super.onEvent(event, ctx);
    const s = this.svc(ctx);
    // Idempotent per originating action: a repeated delivery doesn't create a second task.
    const key = `evt_${event.correlationId}_${event.type}`.slice(0, 120);
    const seen = await s.env.repo.get<{ taskId: string }>(ctx.userId, NS.helpRequests, key);
    if (seen) return { taskId: seen.taskId };
    const task = await this.planTask(ctx, "meal_support", "event");
    await s.env.repo.put(ctx.userId, NS.helpRequests, key, { taskId: task.id, eventId: event.id, difficulty: event.payload.difficulty }, "Meal support requested by Wellness");
    await s.meds.raiseAlert(ctx.userId, {
      kind: "help_request",
      area: "grocery",
      severity: "attention",
      title: "Meal help suggested",
      detail: "Wellness noticed meals may be getting difficult. Care will offer options to the user.",
      relatedIds: [task.id],
    });
    return { taskId: task.id };
  }

  // ── Dashboard read model (permission-filtered on the server) ─────────────

  async getDashboard(ctx: AgentContext) {
    const s = this.svc(ctx);
    const repo = s.env.repo;
    const can = (area: CareArea, mode: "view" | "approve" = "view") => canAccessCare(ctx, area, mode, this.deps.permissions);
    const role: Role = ctx.actor.role;
    if (role === "caregiver") {
      const perm = await this.deps.permissions.getCaregiverPermission(ctx.userId, ctx.actor.id, "care");
      if (!perm) throw new AgentError("PERMISSION_DENIED", "no access to this person's Care information");
      // Audit: who looked, which areas (no data).
      await this.log(ctx, "audit", "info", "Caregiver viewed Care summary", { caregiver: ctx.actor.id, scopes: perm.scopes ?? [] });
    }
    const [viewMeds, viewGrocery, approveMeds, approveGrocery] = await Promise.all([can("medications"), can("grocery"), can("medications", "approve"), can("grocery", "approve")]);
    const profile = await repo.profile(ctx.userId);
    const now = this.deps.now();
    const tz = profile?.timeZone ?? "UTC";
    const denied = (scope: string) => ({ denied: true as const, reason: `Requires ${scope} permission` });

    let medication: unknown = denied("care:medications");
    if (viewMeds) {
      const doses = await s.meds.ensureDoses(ctx.userId, { persist: role !== "caregiver" });
      const meds = await repo.medications(ctx.userId);
      const today = localDateOf(now, tz);
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const refills = await repo.refills(ctx.userId);
      medication = {
        today: meds.map((m) => ({
          medicationId: m.id,
          name: m.name,
          doseText: m.doseText,
          pillsRemaining: m.supplyKnown === false ? null : m.pillsRemaining,
          daysOfSupply: m.supplyKnown === false ? null : daysOfSupply(m),
          refillLeadDays: m.refillLeadDays,
          doses: doses
            .filter((d) => d.medicationId === m.id && d.localDate === today)
            .map((d) => ({
              doseId: d.id,
              slot: d.slot,
              time: friendlyTime(d.scheduledAt, tz),
              state: d.state,
              late: d.confirmation?.late ?? false,
              confirmedAt: d.confirmation ? friendlyTime(d.confirmation.at, tz) : null,
              canConfirm: role === "older_adult" && d.state !== "confirmed" && now >= d.windowStart && now <= d.windowEnd + m.rules.lateConfirmationMaxMin * 60_000,
              history: d.history.map((h) => ({ at: friendlyTime(h.at, tz), event: h.event, to: h.to })),
            })),
        })),
        adherence: adherenceSummary(doses.filter((d) => d.scheduledAt >= weekAgo && d.scheduledAt <= now)),
        recent: doses
          .filter((d) => d.scheduledAt <= now && d.scheduledAt >= weekAgo && (d.state === "confirmed" || d.state === "missed"))
          .sort((a, b) => b.scheduledAt - a.scheduledAt)
          .slice(0, 10)
          .map((d) => ({ doseId: d.id, when: friendlyDateTime(d.scheduledAt, tz), medication: meds.find((m) => m.id === d.medicationId)?.name ?? d.medicationId, state: d.state, late: d.confirmation?.late ?? false })),
        refills: refills
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((r) => ({
            refillId: r.id,
            medication: r.medicationName,
            quantity: r.quantity,
            pharmacy: r.pharmacy?.name ?? null,
            status: r.status,
            missing: r.missing,
            simulated: r.simulated,
            updated: friendlyDateTime(r.updatedAt, tz),
            pharmacyMessages: r.pharmacyMessages.map((m) => ({ text: m.text, flagged: m.flagged })),
          })),
      };
    }

    let grocery: unknown = denied("care:grocery");
    let meals: unknown = denied("care:grocery");
    if (viewGrocery) {
      const prefs = await repo.preferences(ctx.userId);
      const carts = await repo.carts(ctx.userId);
      const cart = [...carts].reverse().find((c) => c.status === "open") ?? null;
      const orders = await repo.orders(ctx.userId);
      grocery = {
        preferences: prefs && {
          allergies: prefs.safety.allergies,
          preferredTags: prefs.safety.preferredTags,
          notes: prefs.notes,
          essentials: prefs.essentials.map((e) => e.label),
          limits: { perOrder: fmt(prefs.limits.perOrderCents), weekly: fmt(prefs.limits.weeklyCents) },
        },
        cart: cart && {
          cartId: cart.id,
          lines: cart.lines.map((l) => ({ name: `${l.brand} ${l.name}`, quantity: l.quantity, price: fmt(l.unitPriceCents * l.quantity), substitutedFor: l.substitutedFor?.name ?? null })),
          pendingSubstitutions: cart.pendingSubstitutions,
          pendingAdditions: cart.pendingAdditions,
          blocked: cart.blocked.map((b) => ({ name: b.name, reasons: b.reasons, source: b.source })),
          total: fmt(cartTotals(cart, prefs?.deliveryFeeCents).totalCents),
          deliveryWindow: cart.deliveryWindow?.label ?? null,
        },
        orders: [...orders].reverse().map((o) => ({
          orderId: o.id,
          status: o.status,
          total: fmt(o.totalCents),
          window: o.deliveryWindow.label,
          items: o.lines.reduce((n, l) => n + l.quantity, 0),
          simulated: o.simulated,
          confirmation: o.confirmationMessage ?? null,
          history: o.statusHistory.map((h) => ({ at: friendlyTime(h.at, tz), status: h.status })),
        })),
      };
      const pantry = await s.meals.pantry(ctx.userId);
      const plan = await repo.get<MealPlanRecord>(ctx.userId, NS.cooking, "latestPlan");
      const cooking = await repo.cooking(ctx.userId);
      const recipe = cooking ? recipeById(cooking.recipeId) : undefined;
      meals = {
        pantry: pantry.items.map((p) => ({ name: p.name, quantity: p.quantity, unit: p.unit, expiresOn: p.expiresOn, allergenInfo: p.allergenInfo })),
        expiringSoon: pantry.expiringSoon.map((p) => ({ name: p.name, expiresOn: p.expiresOn, expired: p.expired })),
        plan,
        cooking: cooking && recipe ? { recipe: cooking.recipeName, step: cooking.stepIndex + 1, totalSteps: cooking.totalSteps, status: cooking.status, say: cooking.status === "active" ? speakStep(cooking, recipe) : null } : null,
      };
    }

    const alerts = [];
    for (const a of (await repo.alerts(ctx.userId)).sort((x, y) => y.createdAt - x.createdAt)) {
      if (a.area === "medications" ? viewMeds : viewGrocery) alerts.push({ ...a, when: friendlyDateTime(a.createdAt, tz) });
    }
    const approvals = [];
    for (const a of await this.store.listApprovals({ userId: ctx.userId, status: ["pending"] })) {
      const rule = APPROVAL_AREAS[a.toolName];
      // Approvals without a caregiver area (e.g. home repairs) are the person's alone: default deny.
      if (!rule && role !== "older_adult") continue;
      if (!this.hasTool(a.toolName)) continue; // tools that no longer exist can't be approved
      const area = rule?.area ?? (a.toolName === "bookHomeRepair" ? "home" : "grocery");
      if (rule && !(area === "medications" ? viewMeds : viewGrocery)) continue;
      const canDecide = role === "older_adult" ? true : !rule?.userOnly && (area === "medications" ? approveMeds : approveGrocery);
      approvals.push({ id: a.id, toolName: a.toolName, summary: a.summary, area, expires: friendlyDateTime(a.expiresAt, tz), canDecide, userOnly: Boolean(rule?.userOnly) });
    }
    const help = viewGrocery || viewMeds ? (await repo.list<HelpRequestRecord>(ctx.userId, NS.helpRequests)).filter((h) => typeof (h as HelpRequestRecord).need === "string") : [];
    const voice = (await repo.voiceLog(ctx.userId))
      .filter((u) => (u.purpose.startsWith("medication") ? viewMeds : viewGrocery))
      .slice(-12)
      .map((u) => ({ id: u.id, at: friendlyTime(u.at, tz), purpose: u.purpose, direction: u.direction, text: u.text, simulated: u.simulated, channelMode: u.channelMode }));

    return {
      viewer: { role, id: ctx.actor.id },
      profile: profile ? { displayName: profile.displayName, isDemo: profile.isDemo, timeZone: tz } : null,
      clock: { now, local: friendlyDateTime(now, tz) },
      access: { medications: viewMeds, grocery: viewGrocery, approveMedications: approveMeds, approveGrocery: approveGrocery },
      medication,
      grocery,
      meals,
      support: { alerts, approvals, helpRequests: help },
      voice,
      memory: await this.listMemories(ctx),
      homeServices:
        role === "older_adult"
          ? await s.homeServices.ownerView(ctx.userId)
          : role === "caregiver" && (await this.canViewHomeServices(ctx))
            ? await s.homeServices.caregiverView(ctx.userId)
            : denied(HOME_SERVICES_SCOPE),
      integrations: describeAdapters(s.env.adapters, this.deps.integrationMode),
    };
  }

  /** Runs an approval decision and returns a compact, UI-safe result. */
  async decide(ctx: AgentContext, approvalId: string, decision: "approve" | "deny") {
    const { approval, result } = await this.resolveApproval(ctx, approvalId, decision);
    return { approval: { id: approval.id, status: approval.status }, result: compact(result) };
  }

  /** Correlation id for multi-step demo flows. */
  static correlation() {
    return newId("cor");
  }
}

function compact(r?: ToolExecutionResult) {
  if (!r) return undefined;
  if (r.status === "error") return { status: "error", error: r.error, code: r.code };
  if (r.status === "approval_required") return { status: r.status };
  return { status: r.status, output: r.output };
}
