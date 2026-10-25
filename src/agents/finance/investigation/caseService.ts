/**
 * Finance bill investigation: the full case lifecycle.
 *
 *   upload two documents ─► extract ─► reconcile ─► analyst review ─► draft
 *        ─► human review (dismiss/restore findings, approve or decline the draft)
 *        ─► submit (only with an approval bound to this exact draft)
 *        ─► track provider responses ─► verify the corrected balance
 *
 * Bounded autonomy: Finance does the investigative work on its own, but it
 * cannot review findings, approve, change the recipient, or move money. Each
 * actor's allowed actions are declared in CASE_CAPABILITIES and checked in code;
 * a denied attempt is itself written to the case's hash-chained audit trail.
 */

import { hashInput } from "../../base/workItems";
import type { Approval, MemoryRecord, ToolContext } from "../../base/types";
import type { DisputeChannel } from "@/integrations/billingOffice";
import { getInvestigationAnalyst, verifySummary, type InvestigationAnalyst } from "./analyst";
import { appendEvent, verifyChain } from "./auditChain";
import { draftHash, letterFacts, templateLetter, verifyLetter } from "./draft";
import { detectKind, MAX_DOCUMENT_CHARS, parseBill, parseEob, scanForSuspiciousContent, sha256 } from "./extract";
import { allowedAmounts, reconcile } from "./reconcile";
import type {
  AnalystObservation,
  CaseActor,
  CaseActorKind,
  CaseStatus,
  ChainEvent,
  DisputeDraft,
  ExtractedBill,
  ExtractedEob,
  InvestigationCase,
  ProviderUpdate,
} from "./types";

export type CaseCtx = Pick<ToolContext, "memory" | "approvals" | "audit" | "correlationId" | "userId">;

const COLLECTION = "investigations";
const DOCS = "caseDocuments";
export const SUBMIT_TOOL = "submitDisputeRequest";

/* ------------------------------------------------------------ capabilities */

export type CaseAction =
  | "case.open"
  | "case.analyze"
  | "draft.prepare"
  | "approval.request"
  | "dispute.submit"
  | "case.track"
  | "resolution.verify"
  | "finding.review"
  | "case.close"
  | "case.respond";

/**
 * Least privilege, per actor. Note what Finance does NOT hold: finding.review,
 * case.close and any payment action. dispute.submit additionally requires an
 * approval bound to the current draft hash (checked in submitApprovedDraft).
 */
export const CASE_CAPABILITIES: Record<CaseActorKind, readonly CaseAction[]> = {
  "finance-agent": ["case.open", "case.analyze", "draft.prepare", "approval.request", "dispute.submit", "case.track", "resolution.verify"],
  reviewer: ["finding.review", "case.close"],
  "billing-office": ["case.respond"],
  system: [],
};

export const FINANCE_AGENT: CaseActor = { kind: "finance-agent", id: "finance" };
export const reviewerActor = (userId: string): CaseActor => ({ kind: "reviewer", id: userId });
const BILLING_OFFICE: CaseActor = { kind: "billing-office", id: "sandbox" };

export function can(actor: CaseActor, action: CaseAction): boolean {
  return CASE_CAPABILITIES[actor.kind]?.includes(action) ?? false;
}

export class CaseActionDenied extends Error {
  constructor(
    readonly actor: CaseActor,
    readonly action: string,
  ) {
    super(`${actor.kind} is not permitted to ${action}.`);
  }
}

/* ---------------------------------------------------------------- storage */

interface Loaded {
  rec: MemoryRecord;
  c: InvestigationCase;
  /** Events appended during this operation, mirrored to the global audit log on save. */
  fresh: ChainEvent[];
}

function push(l: Loaded, actor: CaseActor, action: string, detail: Record<string, unknown> = {}) {
  l.c.chain = appendEvent(l.c.chain, actor, action, detail);
  l.fresh.push(l.c.chain[l.c.chain.length - 1]);
}

async function save(ctx: CaseCtx, l: Loaded): Promise<InvestigationCase> {
  l.c.updatedAt = Date.now();
  await ctx.memory.update(l.rec.id, { ...l.c } as unknown as Record<string, unknown>);
  for (const e of l.fresh) {
    await ctx.audit.record({
      actor: "finance",
      action: `investigation.${e.action}`,
      correlationId: ctx.correlationId,
      detail: { caseId: l.c.caseId, seq: e.seq, by: e.actor, hash: e.hash.slice(0, 16) },
    });
  }
  l.fresh = [];
  return l.c;
}

async function load(ctx: CaseCtx, caseId?: string): Promise<Loaded | null> {
  let rec: MemoryRecord | null | undefined;
  if (caseId) rec = await ctx.memory.get(caseId);
  else rec = [...(await ctx.memory.list(COLLECTION, { limit: 50 }))].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!rec || rec.collection !== COLLECTION) return null;
  return { rec, c: rec.data as unknown as InvestigationCase, fresh: [] };
}

async function authorize(ctx: CaseCtx, l: Loaded, actor: CaseActor, action: CaseAction): Promise<void> {
  if (can(actor, action)) return;
  push(l, actor, "action.denied", { attempted: action, reason: "not in this actor's capabilities" });
  await save(ctx, l);
  throw new CaseActionDenied(actor, action);
}

/* ------------------------------------------------------------- 1-6. open */

export interface UploadedDocument {
  fileName: string;
  text: string;
}

export type OpenResult =
  | { ok: true; caseId: string; case: InvestigationCase; approvalId?: string }
  | { ok: false; errors: string[] };

export async function openInvestigation(
  ctx: CaseCtx,
  input: { documents: UploadedDocument[] },
  analyst: InvestigationAnalyst = getInvestigationAnalyst(),
): Promise<OpenResult> {
  // Bounded input: exactly one statement and one EOB, size-capped.
  const errors: string[] = [];
  if (input.documents.length !== 2) errors.push("Upload exactly two documents: the medical bill and the insurance EOB.");
  const typed = input.documents.map((d) => ({ ...d, kind: detectKind(d.text) }));
  for (const d of typed) {
    if (d.text.length > MAX_DOCUMENT_CHARS) errors.push(`${d.fileName} is too large to review (over ${MAX_DOCUMENT_CHARS.toLocaleString()} characters).`);
    if (!d.kind) errors.push(`${d.fileName} doesn't look like a medical bill or an Explanation of Benefits.`);
  }
  const billIn = typed.find((d) => d.kind === "bill");
  const eobIn = typed.find((d) => d.kind === "eob");
  if (!errors.length && (!billIn || !eobIn)) errors.push("I need one medical bill and one Explanation of Benefits (EOB).");
  if (errors.length) return { ok: false, errors };

  const now = Date.now();
  const billDoc = await ctx.memory.save(DOCS, { kind: "bill", fileName: billIn!.fileName, sha256: sha256(billIn!.text), text: billIn!.text, uploadedAt: now }, { tags: ["case-doc"] });
  const eobDoc = await ctx.memory.save(DOCS, { kind: "eob", fileName: eobIn!.fileName, sha256: sha256(eobIn!.text), text: eobIn!.text, uploadedAt: now }, { tags: ["case-doc"] });
  const hashes = { bill: String(billDoc.data.sha256), eob: String(eobDoc.data.sha256) };

  // 2. Extract: deterministic parser first; Claude only for unknown layouts, and only if grounded.
  const extractionNotes: string[] = [];
  let bill: ExtractedBill | null = null;
  let eob: ExtractedEob | null = null;
  const pb = parseBill(billIn!.text, billDoc.id);
  if (pb.ok) bill = pb.doc;
  else {
    const r = await analyst.extract(billIn!.text, "bill", billDoc.id);
    bill = r.doc as ExtractedBill | null;
    if (!bill) extractionNotes.push(...pb.errors, ...r.problems);
  }
  const pe = parseEob(eobIn!.text, eobDoc.id);
  if (pe.ok) eob = pe.doc;
  else {
    const r = await analyst.extract(eobIn!.text, "eob", eobDoc.id);
    eob = r.doc as ExtractedEob | null;
    if (!eob) extractionNotes.push(...pe.errors, ...r.problems);
  }
  if (!bill || !eob) {
    await ctx.audit.record({ actor: "finance", action: "investigation.extraction_failed", correlationId: ctx.correlationId, detail: { notes: extractionNotes.slice(0, 6) } });
    return { ok: false, errors: ["I couldn't read the numbers reliably, so I stopped rather than guess.", ...extractionNotes.slice(0, 4)] };
  }

  const warnings = [
    ...scanForSuspiciousContent(billIn!.text, bill.provider.billingEmail ? [bill.provider.billingEmail] : []),
    ...scanForSuspiciousContent(eobIn!.text, []),
  ];

  // 3. Reconcile (deterministic authority on every number).
  const rec = reconcile(bill, eob, hashes);
  const allowed = allowedAmounts(bill, eob, rec);

  const c: InvestigationCase = {
    caseId: "",
    status: "awaiting_review",
    title: `${bill.provider.name} statement${bill.statementDate ? ` of ${bill.statementDate}` : ""}`,
    patientName: bill.patientName || eob.memberName,
    documents: [
      { docId: billDoc.id, kind: "bill", fileName: billIn!.fileName, sha256: hashes.bill },
      { docId: eobDoc.id, kind: "eob", fileName: eobIn!.fileName, sha256: hashes.eob },
    ],
    bill,
    eob,
    reconciliation: rec,
    summary: templateSummary(rec, bill, eob),
    summaryBy: "template",
    observations: [],
    warnings,
    draft: null,
    submission: null,
    updates: [],
    resolution: null,
    chain: [],
    createdAt: now,
    updatedAt: now,
  };
  const saved = await ctx.memory.save(COLLECTION, { ...c } as unknown as Record<string, unknown>, { tags: ["investigation"] });
  const l: Loaded = { rec: saved, c: { ...c, caseId: saved.id }, fresh: [] };

  push(l, FINANCE_AGENT, "case.opened", { documents: l.c.documents.map(({ kind, fileName, sha256: h }) => ({ kind, fileName, sha256: h })) });
  push(l, FINANCE_AGENT, "documents.extracted", {
    bill: { by: bill.extractedBy, lines: bill.lines.length, amountDue: bill.totals.amountDue },
    eob: { by: eob.extractedBy, lines: eob.lines.length, patientResp: eob.totals.patientResp },
    warnings: warnings.length,
  });
  push(l, FINANCE_AGENT, "case.analyzed", {
    findings: rec.findings.map((f) => ({ id: f.findingId, type: f.type, amount: f.amountAtIssue })),
    checksPassed: `${rec.checks.filter((x) => x.passed).length}/${rec.checks.length}`,
    difference: rec.difference,
  });

  // 4. Analyst review: advisory, corroborated against the rules engine.
  const review = await analyst.review({ bill, eob, billText: billIn!.text, eobText: eobIn!.text, allowedAmounts: [...allowed] });
  if (review) {
    const lineIds = new Set([...bill.lines.map((x) => x.lineId), ...eob.lines.map((x) => x.lineId)]);
    l.c.observations = review.observations
      .filter((o) => o.lineIds.every((id) => lineIds.has(id)))
      .map<AnalystObservation>((o) => {
        const match = rec.findings.find((f) => f.type === o.type && (o.lineIds.length === 0 || f.evidence.some((e) => e.lineId && o.lineIds.includes(e.lineId))));
        if (match) match.source = "rules+claude";
        return { ...o, corroborated: !!match };
      });
    const summaryProblems = verifySummary(review.summary, allowed);
    if (!summaryProblems.length) {
      l.c.summary = review.summary;
      l.c.summaryBy = "claude";
    }
    push(l, FINANCE_AGENT, "analyst.reviewed", {
      backend: analyst.backend,
      observations: l.c.observations.length,
      uncorroborated: l.c.observations.filter((o) => !o.corroborated).length,
      summaryAccepted: !summaryProblems.length,
      summaryRejectedBecause: summaryProblems.slice(0, 3),
    });
  } else {
    push(l, FINANCE_AGENT, "analyst.reviewed", { backend: analyst.backend, note: analyst.backend === "sandbox" ? "rules engine only" : "no usable analyst output" });
  }

  if (!rec.findings.length) {
    l.c.status = "no_issues_found";
    push(l, FINANCE_AGENT, "case.no_issues_found", {});
    await save(ctx, l);
    return { ok: true, caseId: l.c.caseId, case: l.c };
  }

  // 5. Draft + approval request bound to it.
  const approvalId = await redraft(ctx, l, analyst);
  await save(ctx, l);
  return { ok: true, caseId: l.c.caseId, case: l.c, approvalId };
}

function templateSummary(rec: InvestigationCase["reconciliation"], bill: ExtractedBill, eob: ExtractedEob): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  if (!rec.findings.length) return `The statement from ${bill.provider.name} matches what ${eob.insurer.name} says you owe (${usd(rec.insurerSaysYouOwe)}). I didn't find anything to dispute.`;
  const dup = rec.findings.find((f) => f.type === "duplicate_charge");
  return (
    `The hospital says you owe ${usd(rec.billAmountDue)}, but your insurance says you owe ${usd(rec.insurerSaysYouOwe)}.` +
    (dup ? ` It looks like one test was billed twice, which accounts for ${usd(dup.amountAtIssue)}.` : ` That's a difference of ${usd(rec.difference)}.`) +
    " Nothing will be sent until you approve."
  );
}

/** Build the next draft version from the non-dismissed findings and request a bound approval. */
async function redraft(ctx: CaseCtx, l: Loaded, analyst: InvestigationAnalyst): Promise<string | undefined> {
  const c = l.c;
  await expirePendingApprovals(ctx, c.caseId);
  const included = c.reconciliation.findings.filter((f) => f.review !== "dismissed");
  const facts = letterFacts(c.bill, c.eob, c.reconciliation, included);
  if (!facts) {
    c.draft = null;
    push(l, FINANCE_AGENT, "draft.withdrawn", { reason: included.length ? "no billing contact in the provider letterhead" : "every finding was dismissed by the reviewer" });
    return undefined;
  }
  const allowed = allowedAmounts(c.bill, c.eob, c.reconciliation);
  const template = templateLetter(c.bill, c.eob, c.reconciliation, facts);
  let body = template;
  let draftedBy: DisputeDraft["draftedBy"] = "template";
  let rejected: string[] = [];
  if (analyst.backend === "claude") {
    const proposed = await analyst.writeLetter({ facts: { ...facts, findings: facts.findings.map((f) => ({ title: f.title, amount: f.amountAtIssue })) }, template, allowedAmounts: [...allowed] });
    if (proposed) {
      rejected = verifyLetter(proposed, facts, allowed);
      if (!rejected.length) {
        body = proposed;
        draftedBy = "claude";
      }
    }
  }
  if (verifyLetter(body, facts, allowed).length) throw new Error("Template letter failed verification.");
  const base = { recipient: facts.recipient, subject: facts.subject, body, findingIds: facts.findings.map((f) => f.findingId) };
  c.draft = {
    ...base,
    version: (c.draft?.version ?? 0) + 1,
    kind: facts.kind,
    amountDisputed: facts.amountDisputed,
    expectedBalance: facts.expectedBalance,
    draftHash: draftHash(base),
    draftedBy,
    createdAt: Date.now(),
  };
  push(l, FINANCE_AGENT, "draft.prepared", {
    version: c.draft.version,
    kind: c.draft.kind,
    draftHash: c.draft.draftHash,
    recipient: c.draft.recipient.email,
    findingIds: c.draft.findingIds,
    amountDisputed: c.draft.amountDisputed,
    draftedBy,
    modelDraftRejectedBecause: rejected.slice(0, 3),
  });
  const approval = await ctx.approvals.request({
    toolName: SUBMIT_TOOL,
    toolInput: submitInput(c),
    title: `Send ${c.draft.kind === "dispute" ? "dispute" : "clarification request"} to ${c.bill.provider.name} billing`,
    description: `${c.draft.kind === "dispute" ? `Disputes $${c.draft.amountDisputed.toFixed(2)}` : "Asks them to explain the balance"} and asks for a corrected balance of $${c.draft.expectedBalance.toFixed(2)}. Sent to ${c.draft.recipient.email}. Letter fingerprint ${c.draft.draftHash}.`,
    correlationId: ctx.correlationId,
  });
  push(l, FINANCE_AGENT, "approval.requested", { approvalId: approval.id, draftHash: c.draft.draftHash });
  return approval.id;
}

export function submitInput(c: InvestigationCase): { caseId: string; draftHash: string; recipientEmail: string } {
  return { caseId: c.caseId, draftHash: c.draft?.draftHash ?? "", recipientEmail: c.draft?.recipient.email ?? "" };
}

async function expirePendingApprovals(ctx: CaseCtx, caseId: string): Promise<void> {
  for (const a of await ctx.approvals.list("pending")) {
    if (a.toolName === SUBMIT_TOOL && (a.input as { caseId?: string })?.caseId === caseId) await ctx.approvals.expire(a.id);
  }
}

/* ------------------------------------------------------- human reviewer */

export async function reviewFinding(
  ctx: CaseCtx,
  input: { caseId: string; findingId: string; decision: "dismiss" | "restore"; note?: string },
  actor: CaseActor,
  analyst: InvestigationAnalyst = getInvestigationAnalyst(),
): Promise<{ ok: boolean; error?: string; case?: InvestigationCase; approvalId?: string }> {
  const l = await load(ctx, input.caseId);
  if (!l) return { ok: false, error: "Case not found." };
  await authorize(ctx, l, actor, "finding.review");
  if (l.c.status !== "awaiting_review") return { ok: false, error: "This case is no longer open for review." };
  const f = l.c.reconciliation.findings.find((x) => x.findingId === input.findingId);
  if (!f) return { ok: false, error: "Finding not found." };
  f.review = input.decision === "dismiss" ? "dismissed" : "pending";
  f.reviewNote = input.note?.slice(0, 300);
  push(l, actor, input.decision === "dismiss" ? "finding.dismissed" : "finding.restored", { findingId: f.findingId, note: f.reviewNote });
  const approvalId = await redraft(ctx, l, analyst);
  await save(ctx, l);
  return { ok: true, case: l.c, approvalId };
}

/** The reviewer declines to send anything. Pending approvals are rejected. */
export async function declineCase(
  ctx: CaseCtx,
  input: { caseId: string; reason?: string },
  actor: CaseActor,
  rejectApproval: (approvalId: string) => Promise<unknown>,
): Promise<{ ok: boolean; error?: string; case?: InvestigationCase }> {
  const l = await load(ctx, input.caseId);
  if (!l) return { ok: false, error: "Case not found." };
  await authorize(ctx, l, actor, "case.close");
  if (l.c.status !== "awaiting_review" && l.c.status !== "no_issues_found") return { ok: false, error: "This case can no longer be closed." };
  for (const a of await ctx.approvals.list("pending")) {
    if (a.toolName === SUBMIT_TOOL && (a.input as { caseId?: string })?.caseId === l.c.caseId) await rejectApproval(a.id);
  }
  l.c.status = "closed_no_action";
  push(l, actor, "case.closed_no_action", { reason: input.reason?.slice(0, 300) ?? "reviewer chose not to send" });
  await save(ctx, l);
  return { ok: true, case: l.c };
}

/* ---------------------------------------------------------- 7. submission */

export type SubmitRefusal =
  | "case_not_found"
  | "no_matching_approval"
  | "not_awaiting_review"
  | "no_draft"
  | "draft_changed"
  | "draft_tampered"
  | "recipient_mismatch";

export const SUBMIT_REFUSAL_TEXT: Record<SubmitRefusal, string> = {
  case_not_found: "That case no longer exists.",
  no_matching_approval: "There's no approval for this exact letter, so nothing was sent.",
  not_awaiting_review: "This case was already sent or closed, so nothing was sent again.",
  no_draft: "There's no letter ready to send.",
  draft_changed: "The letter changed after it was approved, so I stopped. Please review the new version.",
  draft_tampered: "The stored letter doesn't match its fingerprint, so I stopped.",
  recipient_mismatch: "The recipient doesn't match the billing office on the statement, so I stopped.",
};

/**
 * Send the approved draft. Approval is necessary but not sufficient: a matching
 * approval record must exist for this exact (case, draft hash, recipient), the
 * stored draft must still hash to that value, the recipient must be the
 * provider's letterhead billing contact, and the case must not already be sent.
 */
export async function submitApprovedDraft(
  ctx: CaseCtx,
  input: { caseId: string; draftHash: string; recipientEmail: string },
  channel: DisputeChannel,
): Promise<{ ok: true; case: InvestigationCase; submissionRef: string } | { ok: false; refusal: SubmitRefusal; message: string }> {
  const l = await load(ctx, input.caseId);
  if (!l) return { ok: false, refusal: "case_not_found", message: SUBMIT_REFUSAL_TEXT.case_not_found };
  await authorize(ctx, l, FINANCE_AGENT, "dispute.submit");

  const want = hashInput(input);
  const approval: Approval | undefined = (await ctx.approvals.list()).find(
    (a) => a.toolName === SUBMIT_TOOL && (a.status === "pending" || a.status === "approved") && hashInput(a.input) === want,
  );
  const c = l.c;
  let refusal: SubmitRefusal | null = null;
  if (!approval) refusal = "no_matching_approval";
  else if (c.status !== "awaiting_review") refusal = "not_awaiting_review";
  else if (!c.draft) refusal = "no_draft";
  else if (c.draft.draftHash !== input.draftHash) refusal = "draft_changed";
  else if (draftHash(c.draft) !== c.draft.draftHash) refusal = "draft_tampered";
  else if (input.recipientEmail !== c.draft.recipient.email || c.draft.recipient.email !== c.bill.provider.billingEmail) refusal = "recipient_mismatch";
  if (refusal) {
    push(l, FINANCE_AGENT, "dispute.submit_refused", { refusal, draftHash: input.draftHash, approvalId: approval?.id });
    await save(ctx, l);
    return { ok: false, refusal, message: SUBMIT_REFUSAL_TEXT[refusal] };
  }

  const draft = c.draft!;
  push(l, reviewerActor(ctx.userId), "draft.approved", { approvalId: approval!.id, draftHash: draft.draftHash, version: draft.version });
  const sent = channel.submit({
    caseId: c.caseId,
    recipientEmail: draft.recipient.email,
    subject: draft.subject,
    body: draft.body,
    idempotencyKey: `${c.caseId}:${draft.draftHash}`,
    expectedBalance: draft.expectedBalance,
    originalBalance: c.reconciliation.billAmountDue,
  });
  for (const f of c.reconciliation.findings) if (draft.findingIds.includes(f.findingId)) f.review = "confirmed";
  c.submission = {
    submissionRef: sent.submissionRef,
    submittedAt: sent.submittedAt,
    channel: channel.backend,
    approvalId: approval!.id,
    approvedBy: ctx.userId,
    draftHash: draft.draftHash,
    recipientEmail: draft.recipient.email,
  };
  c.status = "submitted";
  c.updates = [{ stage: "submitted", label: "Request sent to the billing office", at: sent.submittedAt }];
  push(l, FINANCE_AGENT, "dispute.submitted", { submissionRef: sent.submissionRef, channel: channel.backend, recipient: draft.recipient.email, draftHash: draft.draftHash });
  await save(ctx, l);
  return { ok: true, case: c, submissionRef: sent.submissionRef };
}

/* ----------------------------------------------------- 8. track + verify */

const STAGE_STATUS: Record<ProviderUpdate["stage"], CaseStatus> = {
  submitted: "submitted",
  acknowledged: "acknowledged",
  under_review: "under_review",
  resolved: "resolved",
};

export async function trackCase(ctx: CaseCtx, channel: DisputeChannel, caseId?: string, nowMs?: number): Promise<InvestigationCase | null> {
  const l = await load(ctx, caseId);
  if (!l) return null;
  const c = l.c;
  if (!c.submission || c.resolution) return c;
  await authorize(ctx, l, FINANCE_AGENT, "case.track");
  const updates = channel.track(
    { submissionRef: c.submission.submissionRef, submittedAt: c.submission.submittedAt, expectedBalance: c.draft!.expectedBalance, originalBalance: c.reconciliation.billAmountDue },
    nowMs,
  );
  const seen = new Set(c.updates.map((u) => u.stage));
  const fresh = updates.filter((u) => !seen.has(u.stage));
  if (!fresh.length) return c;
  for (const u of fresh) {
    push(l, BILLING_OFFICE, `provider.${u.stage}`, { providerRef: u.providerRef, message: u.message, correctedBalance: u.correctedBalance });
    c.status = STAGE_STATUS[u.stage];
  }
  c.updates = updates;
  const final = updates.find((u) => u.stage === "resolved");
  if (final && final.correctedBalance !== undefined) {
    const expected = c.draft!.expectedBalance;
    const matches = Math.abs(final.correctedBalance - expected) < 0.005;
    c.resolution = {
      expectedBalance: expected,
      correctedBalance: final.correctedBalance,
      matches,
      detail: matches
        ? `The corrected balance of $${final.correctedBalance.toFixed(2)} matches what your insurance says you owe.`
        : `The new balance of $${final.correctedBalance.toFixed(2)} is still $${(final.correctedBalance - expected).toFixed(2)} more than the $${expected.toFixed(2)} your insurance says you owe. Next step: call ${c.eob.insurer.name}${c.eob.insurer.phone ? ` at ${c.eob.insurer.phone}` : ""} about claim ${c.eob.claimNumber ?? ""}.`.trim(),
    };
    c.status = matches ? "resolved" : "partially_resolved";
    push(l, FINANCE_AGENT, "resolution.verified", { expected, corrected: final.correctedBalance, matches });
  }
  await save(ctx, l);
  return c;
}

/* --------------------------------------------------------- read models */

export async function getCase(ctx: Pick<CaseCtx, "memory">, caseId?: string): Promise<InvestigationCase | null> {
  return (await load(ctx as CaseCtx, caseId))?.c ?? null;
}

export async function caseSnapshot(ctx: Pick<CaseCtx, "memory" | "approvals">, caseId?: string) {
  const c = await getCase(ctx, caseId);
  if (!c) return { case: null, approval: null, chain: null };
  const want = c.draft ? hashInput(submitInput(c)) : null;
  const pending = want
    ? (await ctx.approvals.list("pending")).find((a) => a.toolName === SUBMIT_TOOL && hashInput(a.input) === want) ?? null
    : null;
  return {
    case: c,
    approval: pending && c.status === "awaiting_review" ? { id: pending.id, title: pending.title, description: pending.description } : null,
    chain: verifyChain(c.chain),
  };
}

/** Everything a third party needs to re-check the case without trusting Sahaya. */
export async function evidencePacket(ctx: Pick<CaseCtx, "memory">, caseId?: string) {
  const c = await getCase(ctx, caseId);
  if (!c) return null;
  const docs = await Promise.all(c.documents.map((d) => ctx.memory.get(d.docId)));
  return {
    format: "sahaya.finance.investigation/v1",
    generatedAt: new Date().toISOString(),
    caseId: c.caseId,
    status: c.status,
    documents: c.documents.map((d, i) => ({ ...d, text: String(docs[i]?.data.text ?? ""), sha256Verified: sha256(String(docs[i]?.data.text ?? "")) === d.sha256 })),
    extracted: { bill: c.bill, eob: c.eob },
    reconciliation: c.reconciliation,
    analyst: { summary: c.summary, summaryBy: c.summaryBy, observations: c.observations },
    warnings: c.warnings,
    draft: c.draft,
    submission: c.submission,
    providerUpdates: c.updates,
    resolution: c.resolution,
    auditChain: c.chain,
    auditChainVerification: verifyChain(c.chain),
    howToVerify: "Each auditChain entry's hash is sha256 over canonical JSON of {seq, at, actor, action, detail, prevHash}; the first prevHash is 64 zeros.",
  };
}
