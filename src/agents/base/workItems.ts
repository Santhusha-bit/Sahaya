/**
 * Controlled agent actions (Track 3, extended for agent security + coordination).
 *
 * Cross-agent and sensitive actions become reviewable WORK ITEMS, and nothing
 * executes without a valid, code-enforced approval. The execution gate here is the
 * authority: a work item's status (including one synced from Jira) is NEVER enough
 * on its own. To execute, ALL of these must hold, checked in code:
 *   - the delegation was authorized at proposal time (workItemPolicy.ts)
 *   - the work item is locally "approved"
 *   - the audit history hash chain is intact (no edited/forged events)
 *   - every approval is backed by a chained "approved" event
 *   - every approver held the required role per the reviewer directory
 *   - enough DISTINCT approvers signed (dual control for high-risk actions)
 *   - every approval was for this exact input hash and has not expired
 *   - the approval has not already been consumed (single-use)
 *   - the executing agent is the assigned agent and the tool matches
 *   - the input hash matches (no tampering after approval)
 */

import { createHash } from "node:crypto";
import { id, now } from "@/lib/id";
import type { AgentId } from "./types";
import { isAgentId } from "./types";
import { ReviewerDirectory, authorizeDelegation, riskRequirement } from "./workItemPolicy";

export type WorkItemStatus =
  | "requested"
  | "in_review"
  | "approved"
  | "rejected"
  | "executed"
  | "expired";

export interface WorkItemEvent {
  at: number;
  actor: string;
  action: string;
  detail?: string;
  /** Cross-reference, e.g. the approval id an "approved" event attests to. */
  ref?: string;
  /** sha256(prevHash + canonical event). Makes the history tamper-evident. */
  hash?: string;
}

export interface ApprovalRecord {
  id: string;
  reviewerId: string;
  reviewerName: string;
  reviewerRole: string;
  /** The exact input hash this person approved. */
  inputHash: string;
  approvedAt: number;
  expiresAt: number;
  source: "app" | "jira";
}

export interface WorkItem {
  id: string;
  userId: string;
  requestedAction: string;
  toolName: string;
  requestingAgent: AgentId;
  assignedAgent: AgentId;
  permissionScope: string;
  /** Role a reviewer must hold to approve this, e.g. "caregiver". Set by policy. */
  requiredRole: string;
  /** Distinct approvers needed (2 = dual control). Set by policy. */
  requiredApprovals: number;
  riskTier: "standard" | "high";
  inputHash: string;
  input: unknown;
  status: WorkItemStatus;
  approvals: ApprovalRecord[];
  /** Most recent approver (kept for display). */
  reviewer?: string;
  reviewerRole?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  expiresAt?: number;
  executedAt?: number;
  result?: string;
  /** Single-use: true once the approval has been spent. */
  consumed?: boolean;
  /** Back-reference to an external tracker (e.g. a Jira issue key). */
  externalKey?: string;
  /** External change ids already applied (idempotent Jira sync). */
  syncedExternalEvents?: string[];
  history: WorkItemEvent[];
}

/** Canonical, order-independent hash of a tool input. */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex").slice(0, 32);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/* ------------------------------------------------------------------ */
/* Tamper-evident audit trail                                          */
/* ------------------------------------------------------------------ */

const GENESIS = "genesis";

function eventHash(prev: string, ev: WorkItemEvent): string {
  const { hash: _ignored, ...body } = ev;
  return createHash("sha256").update(prev + canonicalize(body)).digest("hex");
}

/** Append an event, chaining it to the previous one. */
export function appendEvent(history: WorkItemEvent[], ev: Omit<WorkItemEvent, "hash">): WorkItemEvent[] {
  const prev = history.length ? history[history.length - 1].hash ?? GENESIS : GENESIS;
  const clean: WorkItemEvent = { ...ev };
  for (const k of Object.keys(clean) as (keyof WorkItemEvent)[]) if (clean[k] === undefined) delete clean[k];
  return [...history, { ...clean, hash: eventHash(prev, clean) }];
}

/** Index of the first broken link in the chain, or -1 if intact. */
export function verifyHistory(history: WorkItemEvent[]): number {
  let prev = GENESIS;
  for (let i = 0; i < history.length; i++) {
    const ev = history[i];
    if (!ev.hash || ev.hash !== eventHash(prev, ev)) return i;
    prev = ev.hash;
  }
  return -1;
}

export function auditHead(item: WorkItem): string {
  return (item.history[item.history.length - 1]?.hash ?? GENESIS).slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** Storage surface. A sandbox local store and a JiraAdapter both implement this. */
export interface WorkItemStore {
  readonly backend: "sandbox" | "jira";
  put(item: WorkItem): Promise<WorkItem>;
  get(id: string): Promise<WorkItem | null>;
  patch(id: string, patch: Partial<WorkItem>): Promise<WorkItem | null>;
  list(userId: string): Promise<WorkItem[]>;
}

export class SandboxWorkItemStore implements WorkItemStore {
  readonly backend = "sandbox" as const;
  private items = new Map<string, WorkItem>();

  async put(item: WorkItem): Promise<WorkItem> {
    this.items.set(item.id, item);
    return item;
  }
  async get(itemId: string): Promise<WorkItem | null> {
    return this.items.get(itemId) ?? null;
  }
  async patch(itemId: string, patch: Partial<WorkItem>): Promise<WorkItem | null> {
    const cur = this.items.get(itemId);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: now() };
    this.items.set(itemId, next);
    return next;
  }
  async list(userId: string): Promise<WorkItem[]> {
    return [...this.items.values()].filter((i) => i.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  }
}

/* ------------------------------------------------------------------ */
/* Execution gate                                                      */
/* ------------------------------------------------------------------ */

export interface ExecutionAttempt {
  agentId: AgentId;
  toolName: string;
  input: unknown;
  nowMs?: number;
}

export type GateCode =
  | "not_approved"
  | "wrong_agent"
  | "wrong_tool"
  | "input_tampered"
  | "wrong_reviewer_role"
  | "expired"
  | "already_consumed"
  | "no_reviewer"
  | "insufficient_approvals"
  | "audit_tampered"
  | "unbacked_approval";

export interface GateResult {
  ok: boolean;
  reason?: string;
  code?: GateCode;
}

/**
 * The deterministic execution gate. Pure validation, no side effects. Returns
 * why execution is refused, so a Jira "Approved" status alone can never pass.
 */
export function evaluateGate(item: WorkItem, attempt: ExecutionAttempt): GateResult {
  const at = attempt.nowMs ?? now();
  const approvals = item.approvals ?? [];

  if (item.status === "expired") return { ok: false, code: "expired", reason: "The approval has expired." };
  if (item.status !== "approved") return { ok: false, code: "not_approved", reason: `Work item is "${item.status}", not approved.` };
  if (item.consumed) return { ok: false, code: "already_consumed", reason: "This approval was already used (single-use)." };

  const broken = verifyHistory(item.history);
  if (broken !== -1)
    return { ok: false, code: "audit_tampered", reason: `Audit trail hash chain is broken at event #${broken}.` };

  if (!approvals.length) return { ok: false, code: "no_reviewer", reason: "No reviewer approval is recorded." };

  const attested = new Set(item.history.filter((e) => e.action === "approved" && e.ref).map((e) => e.ref));
  for (const a of approvals) {
    if (!attested.has(a.id))
      return { ok: false, code: "unbacked_approval", reason: `Approval ${a.id} has no matching audited approval event.` };
    if (a.reviewerRole !== item.requiredRole)
      return { ok: false, code: "wrong_reviewer_role", reason: `Reviewer role "${a.reviewerRole}" cannot approve; "${item.requiredRole}" is required.` };
    if (a.inputHash !== item.inputHash)
      return { ok: false, code: "input_tampered", reason: "An approval was given for different input than the work item now holds." };
    if (at >= a.expiresAt) return { ok: false, code: "expired", reason: `${a.reviewerName}'s approval has expired.` };
  }

  const distinct = new Set(approvals.map((a) => a.reviewerId)).size;
  if (distinct < (item.requiredApprovals ?? 1))
    return {
      ok: false,
      code: "insufficient_approvals",
      reason: `${distinct} of ${item.requiredApprovals} required distinct approvals.`,
    };

  if (attempt.agentId !== item.assignedAgent) return { ok: false, code: "wrong_agent", reason: `Agent "${attempt.agentId}" is not the assigned agent.` };
  if (attempt.toolName !== item.toolName) return { ok: false, code: "wrong_tool", reason: `Tool "${attempt.toolName}" does not match the approved tool.` };
  if (hashInput(attempt.input) !== item.inputHash) return { ok: false, code: "input_tampered", reason: "The input does not match what was approved." };

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export interface CreateWorkItemInput {
  userId: string;
  requestedAction: string;
  toolName: string;
  requestingAgent: AgentId;
  assignedAgent: AgentId;
  permissionScope: string;
  input: unknown;
}

export type ReviewCode =
  | "unknown_item"
  | "not_reviewable"
  | "unknown_reviewer"
  | "reviewer_is_agent"
  | "wrong_reviewer_role"
  | "duplicate_approver";

export interface ReviewOutcome {
  ok: boolean;
  item: WorkItem | null;
  code?: ReviewCode;
  reason?: string;
}

/** Orchestrates the work-item lifecycle over any WorkItemStore. */
export class WorkItemService {
  readonly directory: ReviewerDirectory;

  constructor(
    private readonly store: WorkItemStore,
    directory?: ReviewerDirectory,
  ) {
    this.directory = directory ?? new ReviewerDirectory([]);
  }

  get backend() {
    return this.store.backend;
  }

  /**
   * Record a request. Delegation is authorized here; a denied request is still
   * stored (status "rejected") so blocked attempts are part of the audit trail.
   * Reviewer role, approval count and lifetime come from policy, not the caller.
   */
  async propose(input: CreateWorkItemInput): Promise<WorkItem> {
    const at = now();
    const risk = riskRequirement(input.toolName, input.input);
    const decision = authorizeDelegation(input);
    let history = appendEvent([], { at, actor: input.requestingAgent, action: "proposed", detail: input.requestedAction });
    history = decision.ok
      ? appendEvent(history, {
          at,
          actor: "policy",
          action: "submitted_for_review",
          detail: `assigned=${input.assignedAgent} scope=${input.permissionScope} tier=${risk.tier} needs ${risk.requiredApprovals}x ${risk.requiredRole}`,
        })
      : appendEvent(history, { at, actor: "policy", action: "delegation_denied", detail: decision.reason });

    const item: WorkItem = {
      id: id("wi"),
      userId: input.userId,
      requestedAction: input.requestedAction,
      toolName: input.toolName,
      requestingAgent: input.requestingAgent,
      assignedAgent: input.assignedAgent,
      permissionScope: input.permissionScope,
      requiredRole: risk.requiredRole,
      requiredApprovals: risk.requiredApprovals,
      riskTier: risk.tier,
      inputHash: hashInput(input.input),
      input: input.input,
      status: decision.ok ? "in_review" : "rejected",
      approvals: [],
      createdAt: at,
      updatedAt: at,
      history,
    };
    return this.store.put(item);
  }

  /**
   * Approve as an identified reviewer. The role is looked up in the directory for
   * this household; a caller cannot assert it. Becomes "approved" only once
   * enough distinct reviewers have signed.
   */
  async approve(
    itemId: string,
    opts: { reviewerId: string; ttlMs?: number; source?: "app" | "jira" },
  ): Promise<ReviewOutcome> {
    const item = await this.store.get(itemId);
    if (!item) return { ok: false, item: null, code: "unknown_item", reason: "Unknown work item." };
    const at = now();

    const deny = async (code: ReviewCode, reason: string): Promise<ReviewOutcome> => {
      const updated = await this.store.patch(itemId, {
        history: appendEvent(item.history, { at, actor: opts.reviewerId, action: "approval_denied", detail: reason }),
      });
      return { ok: false, item: updated, code, reason };
    };

    if (item.status !== "in_review") return deny("not_reviewable", `Work item is "${item.status}", not awaiting review.`);
    if (isAgentId(opts.reviewerId)) return deny("reviewer_is_agent", "Agents cannot approve work items (separation of duties).");
    const principal = this.directory.get(item.userId, opts.reviewerId);
    if (!principal) return deny("unknown_reviewer", `"${opts.reviewerId}" is not a registered reviewer for this household.`);
    if (!principal.roles.includes(item.requiredRole))
      return deny("wrong_reviewer_role", `${principal.name} holds [${principal.roles.join(", ")}]; "${item.requiredRole}" is required.`);
    if ((item.approvals ?? []).some((a) => a.reviewerId === principal.id))
      return deny("duplicate_approver", `${principal.name} already approved; a different reviewer must sign.`);

    const approval: ApprovalRecord = {
      id: id("apv"),
      reviewerId: principal.id,
      reviewerName: principal.name,
      reviewerRole: item.requiredRole,
      inputHash: item.inputHash,
      approvedAt: at,
      expiresAt: at + (opts.ttlMs ?? 15 * 60_000),
      source: opts.source ?? "app",
    };
    const approvals = [...(item.approvals ?? []), approval];
    const complete = new Set(approvals.map((a) => a.reviewerId)).size >= item.requiredApprovals;
    let history = appendEvent(item.history, {
      at,
      actor: principal.id,
      action: "approved",
      ref: approval.id,
      detail: `${principal.name} role=${item.requiredRole} via ${approval.source} for input ${item.inputHash.slice(0, 8)} (${approvals.length}/${item.requiredApprovals})`,
    });
    if (complete) history = appendEvent(history, { at, actor: "policy", action: "authorization_complete" });

    const updated = await this.store.patch(itemId, {
      approvals,
      status: complete ? "approved" : "in_review",
      reviewer: principal.name,
      reviewerRole: item.requiredRole,
      approvedAt: complete ? at : item.approvedAt,
      expiresAt: Math.min(...approvals.map((a) => a.expiresAt)),
      consumed: false,
      history,
    });
    return { ok: true, item: updated };
  }

  async reject(itemId: string, opts: { reviewerId: string; reason?: string; source?: "app" | "jira" }): Promise<ReviewOutcome> {
    const item = await this.store.get(itemId);
    if (!item) return { ok: false, item: null, code: "unknown_item", reason: "Unknown work item." };
    if (item.status !== "in_review" && item.status !== "approved")
      return { ok: false, item, code: "not_reviewable", reason: `Work item is "${item.status}".` };
    // Any registered reviewer for the household may veto, regardless of role.
    const principal = isAgentId(opts.reviewerId) ? null : this.directory.get(item.userId, opts.reviewerId);
    if (!principal) return { ok: false, item, code: "unknown_reviewer", reason: "Only a registered household reviewer can reject." };
    const updated = await this.store.patch(itemId, {
      status: "rejected",
      reviewer: principal.name,
      history: appendEvent(item.history, {
        at: now(),
        actor: principal.id,
        action: "rejected",
        detail: `${opts.reason ?? "rejected"} (via ${opts.source ?? "app"})`,
      }),
    });
    return { ok: true, item: updated };
  }

  /**
   * Apply a decision observed in an external tracker (e.g. a Jira transition).
   * It counts ONLY if the external account maps to a registered reviewer, and it
   * then goes through the same approve/reject checks as an in-app decision.
   */
  async applyExternalDecision(
    itemId: string,
    d: { decision: "approve" | "reject"; externalAccountId: string; externalEventId: string; source: "jira"; label?: string },
  ): Promise<ReviewOutcome & { skipped?: boolean }> {
    const item = await this.store.get(itemId);
    if (!item) return { ok: false, item: null, code: "unknown_item", reason: "Unknown work item." };
    if (item.syncedExternalEvents?.includes(d.externalEventId)) return { ok: true, item, skipped: true };
    const seen = { syncedExternalEvents: [...(item.syncedExternalEvents ?? []), d.externalEventId] };

    const principal = this.directory.byJiraAccount(item.userId, d.externalAccountId);
    if (!principal) {
      const updated = await this.store.patch(itemId, {
        ...seen,
        history: appendEvent(item.history, {
          at: now(),
          actor: `${d.source}:${d.externalAccountId}`,
          action: "external_decision_ignored",
          detail: `"${d.label ?? d.decision}" by an account that is not a registered reviewer`,
        }),
      });
      return { ok: false, item: updated, code: "unknown_reviewer", reason: "External account is not a registered reviewer." };
    }
    await this.store.patch(itemId, seen);
    return d.decision === "approve"
      ? this.approve(itemId, { reviewerId: principal.id, source: d.source })
      : this.reject(itemId, { reviewerId: principal.id, reason: d.label, source: d.source });
  }

  /**
   * Execute through the gate. The executor runs ONLY if the gate passes. On
   * success the approval is consumed (single-use) and the result synced back.
   */
  async execute(
    itemId: string,
    attempt: ExecutionAttempt,
    executor: (item: WorkItem) => Promise<string>,
  ): Promise<{ ok: boolean; item: WorkItem | null; result?: string; gate: GateResult }> {
    let item = await this.store.get(itemId);
    if (!item) return { ok: false, item: null, gate: { ok: false, code: "not_approved", reason: "Unknown work item." } };

    // Expire lazily so the status reflects reality in the dashboard.
    if (item.status === "approved" && item.expiresAt !== undefined && (attempt.nowMs ?? now()) >= item.expiresAt) {
      item = (await this.store.patch(itemId, {
        status: "expired",
        history: appendEvent(item.history, { at: now(), actor: "system", action: "expired" }),
      }))!;
    }

    const gate = evaluateGate(item, attempt);
    if (!gate.ok) {
      // Never extend a broken chain: appending would re-seal forged history.
      if (gate.code !== "audit_tampered") {
        item =
          (await this.store.patch(itemId, {
            history: appendEvent(item.history, {
              at: now(),
              actor: attempt.agentId,
              action: "execution_denied",
              detail: `${gate.code}: ${gate.reason}`,
            }),
          })) ?? item;
      }
      return { ok: false, item, gate };
    }

    // Consume BEFORE running so a concurrent replay cannot pass the gate too.
    await this.store.patch(itemId, {
      consumed: true,
      history: appendEvent(item.history, { at: now(), actor: attempt.agentId, action: "execution_started" }),
    });
    const started = (await this.store.get(itemId))!;
    let result: string;
    try {
      result = await executor(started);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failed = await this.store.patch(itemId, {
        history: appendEvent(started.history, { at: now(), actor: attempt.agentId, action: "execution_failed", detail: msg }),
      });
      return { ok: false, item: failed, gate: { ok: false, code: "already_consumed", reason: `Execution failed: ${msg}` } };
    }
    const at = now();
    const updated = await this.store.patch(itemId, {
      status: "executed",
      executedAt: at,
      result,
      history: appendEvent(started.history, { at, actor: attempt.agentId, action: "executed", detail: result }),
    });
    return { ok: true, item: updated, result, gate };
  }

  async list(userId: string): Promise<WorkItem[]> {
    return this.store.list(userId);
  }
  async get(itemId: string): Promise<WorkItem | null> {
    return this.store.get(itemId);
  }
}
