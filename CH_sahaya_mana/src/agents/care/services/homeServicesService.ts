import { newId } from "@/lib/ids";
import type { EnvLike } from "@/lib/config/env";
import { homeServiceProvider } from "@/integrations/getterdone/provider";
import { AgentError } from "../../base/errors";
import {
  STATUS_LABEL,
  TRADE,
  acceptableWindow,
  approvalInput,
  bookedTitle,
  issueSummary,
  money,
  offerTimeWindows,
  proposalHash,
  safetyFor,
  statusAt,
  validateRequest,
  type HomeBooking,
  type HomeProposal,
  type HomeRequest,
  type ServiceKind,
} from "../domain/homeServices";
import { NS } from "../repository";
import type { CareEnv } from "./env";

const key = (kind: string, id: string) => `${kind}:${id}`;
type Row = HomeRequest | HomeProposal | HomeBooking;
export type BookingInput = ReturnType<typeof approvalInput>;

/**
 * Home repair and household help. Records live in Care's `care.homeServices` namespace: requests and proposals are
 * the person's own; bookings are also visible to caregivers holding the view-only `care:home-services` scope.
 * Booking happens only in book(), which the registry runs after consuming a valid, single-use approval.
 * Audit entries carry ids, the service kind and the reference — never the description or notes.
 */
export class HomeServicesService {
  constructor(private readonly env: CareEnv, private readonly processEnv: EnvLike = process.env) {}

  private provider() {
    return homeServiceProvider(this.processEnv);
  }

  private async timeZone(userId: string) {
    return (await this.env.repo.profile(userId))?.timeZone ?? "America/Los_Angeles";
  }

  private async rows(userId: string): Promise<Row[]> {
    return (await this.env.repo.list<Row>(userId, NS.homeServices)).filter((r) => r && typeof r === "object" && "kind" in r);
  }
  private async save(userId: string, r: Row) {
    await this.env.repo.put(userId, NS.homeServices, key(r.kind, r.id), r, r.kind === "booking" ? "Home repair booking" : "Home repair request");
  }
  private async get<T extends Row>(userId: string, kind: T["kind"], id: string, what: string) {
    return this.env.repo.require<T>(userId, NS.homeServices, key(kind, id), what);
  }

  async request(userId: string, id: string) {
    return this.get<HomeRequest>(userId, "request", id, "Home repair request");
  }
  async proposal(userId: string, id: string) {
    return this.get<HomeProposal>(userId, "proposal", id, "Home repair request");
  }

  /** Stage 1: understand the problem; safety steps first; offer 2–3 arrival windows. */
  async startRequest(userId: string, input: { requestId?: string; service: ServiceKind; description: string; householdNotes?: string; preferredTiming?: string }) {
    this.provider(); // fails early (and plainly) if home services are switched off or refused in production
    const problems = validateRequest(input);
    if (problems.length) throw new AgentError("VALIDATION_FAILED", problems.join(" "));
    const now = this.env.now();
    const existing = input.requestId ? await this.request(userId, input.requestId).catch(() => null) : null;
    if (input.requestId && !existing) throw new AgentError("NOT_FOUND", "That request wasn't found.");
    const safety = safetyFor(input.service, `${input.description} ${input.householdNotes ?? ""}`);
    const req: HomeRequest = {
      kind: "request",
      id: existing?.id ?? newId("hsr"),
      version: (existing?.version ?? 0) + 1,
      service: input.service,
      description: input.description.trim(),
      householdNotes: input.householdNotes?.trim() || undefined,
      preferredTiming: input.preferredTiming?.trim() || undefined,
      emergency: safety.emergency,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.save(userId, req);
    if (existing) await this.supersede(userId, req.id, "Home repair details changed");
    await this.env.audit(userId, "audit", existing ? "Home repair request changed" : "Home repair request started", { requestId: req.id, service: req.service, emergency: req.emergency });
    const windows = offerTimeWindows(now, await this.timeZone(userId));
    return { requestId: req.id, service: req.service, trade: TRADE[req.service], safety, timeWindows: windows.map((w) => ({ windowId: w.windowId, label: w.label })) };
  }

  /** Expire pending approvals of earlier proposals for this request. Returns how many approvals were invalidated. */
  private async supersede(userId: string, requestId: string, why: string) {
    let invalidated = 0;
    for (const p of (await this.rows(userId)).filter((r): r is HomeProposal => r.kind === "proposal" && r.requestId === requestId && (r.status === "proposed" || r.status === "approval_requested"))) {
      if (p.approvalId && (await this.env.store.transitionApproval(p.approvalId, "pending", { status: "expired" }))) {
        const a = await this.env.store.getApproval(p.approvalId);
        await this.env.store.saveApproval({ ...a, summary: `${why} — replaced by a new request`, input: { superseded: true }, inputHash: "superseded" });
        invalidated++;
      }
      await this.save(userId, { ...p, status: "superseded", updatedAt: this.env.now() });
    }
    return invalidated;
  }

  /** Stage 2: the chosen time window → provider + estimate → a proposal (the approval card is created by the agent). */
  async propose(userId: string, input: { requestId: string; windowId: string }) {
    const req = await this.request(userId, input.requestId);
    const window = acceptableWindow(input.windowId, this.env.now(), await this.timeZone(userId));
    if (!window) throw new AgentError("VALIDATION_FAILED", "That time isn't available any more. Please pick one of the times offered.");
    const quote = await this.provider().quote({ service: req.service, windowStart: window.start, windowEnd: window.end });
    const changed = await this.supersede(userId, req.id, "Time changed");
    const now = this.env.now();
    const base = { kind: "proposal" as const, id: newId("hsp"), requestId: req.id, requestVersion: req.version, service: req.service, issue: issueSummary(req.description), window, provider: quote.provider, estimateCents: quote.estimateCents };
    const proposal: HomeProposal = { ...base, hash: proposalHash(base), status: "proposed", createdAt: now, updatedAt: now };
    await this.save(userId, proposal);
    if (changed) await this.env.audit(userId, "audit", "Home repair time changed", { requestId: req.id, proposalId: proposal.id, invalidatedApprovals: changed });
    await this.env.audit(userId, "audit", "Home repair proposal created", { requestId: req.id, proposalId: proposal.id, service: req.service, proposalHash: proposal.hash });
    return proposal;
  }

  /** Runs before the approval is requested AND again right before an approved booking executes. */
  async verify(userId: string, input: BookingInput) {
    const p = await this.proposal(userId, input.proposalId);
    if (p.status === "superseded") throw new AgentError("APPROVAL_INVALID", "The time or details changed. Please approve the new request.");
    if (p.status === "declined") throw new AgentError("APPROVAL_INVALID", "This request was declined.");
    if (p.status === "booked") throw new AgentError("APPROVAL_INVALID", "This is already booked.");
    const expected = approvalInput(p);
    for (const k of Object.keys(expected) as Array<keyof BookingInput>) {
      if (expected[k] !== input[k]) throw new AgentError("APPROVAL_INVALID", "That approval doesn't match the request on screen. Please check it again.");
    }
    const req = await this.request(userId, p.requestId);
    if (req.version !== p.requestVersion) throw new AgentError("APPROVAL_INVALID", "The details changed. Please approve the new request.");
    if (p.window.start <= this.env.now()) throw new AgentError("APPROVAL_INVALID", "That time has passed. Please pick a new time.");
    return p;
  }

  async markApprovalRequested(userId: string, proposalId: string, approvalId: string) {
    const p = await this.proposal(userId, proposalId);
    await this.save(userId, { ...p, status: "approval_requested", approvalId, updatedAt: this.env.now() });
    await this.env.audit(userId, "audit", "Home repair approval requested", { proposalId, approvalId });
  }

  /** Stage 3 (only via the registry after a consumed approval): book through the provider adapter. */
  async book(userId: string, actorId: string, input: BookingInput) {
    const p = await this.verify(userId, input);
    const result = await this.provider().book({ service: p.service, windowStart: p.window.start, windowEnd: p.window.end, proposalHash: p.hash, userKey: userId });
    const now = this.env.now();
    const status = statusAt(p.window, now);
    const booking: HomeBooking = {
      kind: "booking",
      id: newId("hsb"),
      proposalId: p.id,
      service: p.service,
      title: bookedTitle(p.service),
      issue: p.issue,
      provider: result.provider,
      window: { ...p.window, start: result.arrival.start, end: result.arrival.end },
      reference: result.reference,
      estimateCents: p.estimateCents,
      status,
      history: [{ status: "booked", at: now }, ...(status !== "booked" ? [{ status, at: now }] : [])],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(userId, booking);
    await this.save(userId, { ...p, status: "booked", bookingId: booking.id, updatedAt: now });
    await this.env.audit(userId, "audit", "Home repair booking created", { bookingId: booking.id, proposalId: p.id, service: p.service, reference: booking.reference, approvedBy: actorId });
    return this.card(booking);
  }

  card(b: HomeBooking) {
    return { bookingId: b.id, title: b.title, service: b.service, issue: b.issue, provider: b.provider, arrivalWindow: b.window.label, reference: b.reference, status: STATUS_LABEL[b.status], statusCode: b.status, estimate: money(b.estimateCents) };
  }

  async decline(userId: string, proposalId: string) {
    const p = await this.proposal(userId, proposalId).catch(() => null);
    if (!p || p.status === "booked") return;
    await this.save(userId, { ...p, status: "declined", updatedAt: this.env.now() });
    await this.env.audit(userId, "audit", "Home repair request declined", { proposalId });
  }

  async auditRejected(userId: string, data: Record<string, unknown>) {
    await this.env.audit(userId, "audit", "Home repair booking attempt rejected", data, "warn");
  }

  /** Clock-driven status (Booked → On the way → Done). Persisted and audited only for the person's own reads. */
  async bookings(userId: string, persist: boolean) {
    const now = this.env.now();
    const out: HomeBooking[] = [];
    for (const b of (await this.rows(userId)).filter((r): r is HomeBooking => r.kind === "booking")) {
      const status = statusAt(b.window, now);
      if (status !== b.status) {
        const next: HomeBooking = { ...b, status, history: [...b.history, { status, at: now }], updatedAt: now };
        if (persist) {
          await this.save(userId, next);
          await this.env.audit(userId, "audit", "Home repair status changed", { bookingId: b.id, status });
        }
        out.push(next);
      } else out.push(b);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** True when the latest booking for this person is confirmed (used by the reply check). */
  async hasConfirmedBooking(userId: string) {
    return (await this.rows(userId)).some((r) => r.kind === "booking");
  }

  /** Recent home-repair activity (within 12 h) — used to apply the wording rules to follow-up turns. */
  async activeConversation(userId: string) {
    const since = this.env.now() - 12 * 60 * 60_000;
    return (await this.rows(userId)).some((r) => r.kind !== "booking" && r.updatedAt >= since);
  }

  async ownerView(userId: string) {
    const rows = await this.rows(userId);
    const proposals = rows.filter((r): r is HomeProposal => r.kind === "proposal").sort((a, b) => b.updatedAt - a.updatedAt);
    const pending = proposals.find((p) => p.status === "approval_requested" || p.status === "proposed") ?? null;
    const requests = rows.filter((r): r is HomeRequest => r.kind === "request").sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = requests[0] ?? null;
    const tz = await this.timeZone(userId);
    const open = latest && !proposals.some((p) => p.requestId === latest.id && p.status !== "superseded") ? latest : null;
    const audit = (await this.env.store.listLogs({ userId, limit: 500 }))
      .filter((l) => l.kind === "audit" && l.message.startsWith("Home repair"))
      .slice(-15)
      .reverse()
      .map((l) => ({ at: l.at, message: l.message }));
    return {
      pending: pending && {
        proposalId: pending.id,
        requestId: pending.requestId,
        approvalId: pending.approvalId ?? null,
        service: pending.service,
        issue: pending.issue,
        time: pending.window.label,
        provider: pending.provider,
        cost: money(pending.estimateCents),
      },
      openRequest: open && {
        requestId: open.id,
        service: open.service,
        issue: issueSummary(open.description),
        safety: safetyFor(open.service, `${open.description} ${open.householdNotes ?? ""}`),
        timeWindows: offerTimeWindows(this.env.now(), tz).map((w) => ({ windowId: w.windowId, label: w.label })),
      },
      changeTimes: pending ? offerTimeWindows(this.env.now(), tz).filter((w) => w.windowId !== pending.window.windowId).map((w) => ({ windowId: w.windowId, label: w.label })) : [],
      bookings: (await this.bookings(userId, true)).map((b) => this.card(b)),
      audit,
    };
  }

  async caregiverView(userId: string) {
    return { bookings: (await this.bookings(userId, false)).map((b) => this.card(b)) };
  }
}
