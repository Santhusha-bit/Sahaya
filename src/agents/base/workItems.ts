/**
 * Controlled agent actions (Track 3).
 *
 * Cross-agent and sensitive actions become reviewable WORK ITEMS, and nothing
 * executes without a valid, code-enforced approval. The execution gate here is the
 * authority: a work item's status (including one synced from Jira) is NEVER enough
 * on its own. To execute, ALL of these must hold, checked in code:
 *   - the work item is locally "approved"
 *   - the executing agent is the assigned agent
 *   - the tool name matches
 *   - the input hash matches (no tampering after approval)
 *   - the reviewer held the required role
 *   - the approval has not expired
 *   - the approval has not already been consumed (single-use)
 */

import { createHash } from "node:crypto";
import { id, now } from "@/lib/id";
import type { AgentId } from "./types";

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
}

export interface WorkItem {
  id: string;
  userId: string;
  requestedAction: string;
  toolName: string;
  requestingAgent: AgentId;
  assignedAgent: AgentId;
  permissionScope: string;
  /** Role a reviewer must hold to approve this, e.g. "caregiver". */
  requiredRole: string;
  inputHash: string;
  input: unknown;
  status: WorkItemStatus;
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
  history: WorkItemEvent[];
}

/** Canonical, order-independent hash of a tool input. */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex").slice(0, 32);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/** Storage surface — a sandbox local store and a JiraAdapter both implement this. */
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

export interface ExecutionAttempt {
  agentId: AgentId;
  toolName: string;
  input: unknown;
  /** The role the acting reviewer's approval must satisfy (checked against the item). */
  nowMs?: number;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
  code?:
    | "not_approved"
    | "wrong_agent"
    | "wrong_tool"
    | "input_tampered"
    | "wrong_reviewer_role"
    | "expired"
    | "already_consumed"
    | "no_reviewer";
}

/**
 * The deterministic execution gate. Pure validation — no side effects. Returns
 * why execution is refused, so a Jira "Approved" status alone can never pass.
 */
export function evaluateGate(item: WorkItem, attempt: ExecutionAttempt): GateResult {
  const at = attempt.nowMs ?? now();

  if (item.status === "expired") return { ok: false, code: "expired", reason: "The approval has expired." };
  if (item.status !== "approved") return { ok: false, code: "not_approved", reason: `Work item is "${item.status}", not approved.` };
  if (item.consumed) return { ok: false, code: "already_consumed", reason: "This approval was already used (single-use)." };
  if (!item.reviewer || !item.reviewerRole) return { ok: false, code: "no_reviewer", reason: "No reviewer recorded on the approval." };
  if (item.reviewerRole !== item.requiredRole)
    return { ok: false, code: "wrong_reviewer_role", reason: `Reviewer role "${item.reviewerRole}" cannot approve; "${item.requiredRole}" is required.` };
  if (item.expiresAt !== undefined && at >= item.expiresAt) return { ok: false, code: "expired", reason: "The approval has expired." };
  if (attempt.agentId !== item.assignedAgent) return { ok: false, code: "wrong_agent", reason: `Agent "${attempt.agentId}" is not the assigned agent.` };
  if (attempt.toolName !== item.toolName) return { ok: false, code: "wrong_tool", reason: `Tool "${attempt.toolName}" does not match the approved tool.` };
  if (hashInput(attempt.input) !== item.inputHash) return { ok: false, code: "input_tampered", reason: "The input does not match what was approved." };

  return { ok: true };
}

export interface CreateWorkItemInput {
  userId: string;
  requestedAction: string;
  toolName: string;
  requestingAgent: AgentId;
  assignedAgent: AgentId;
  permissionScope: string;
  requiredRole: string;
  input: unknown;
}

/** Orchestrates the work-item lifecycle over any WorkItemStore. */
export class WorkItemService {
  constructor(private readonly store: WorkItemStore) {}

  get backend() {
    return this.store.backend;
  }

  async propose(input: CreateWorkItemInput): Promise<WorkItem> {
    const at = now();
    const item: WorkItem = {
      id: id("wi"),
      userId: input.userId,
      requestedAction: input.requestedAction,
      toolName: input.toolName,
      requestingAgent: input.requestingAgent,
      assignedAgent: input.assignedAgent,
      permissionScope: input.permissionScope,
      requiredRole: input.requiredRole,
      inputHash: hashInput(input.input),
      input: input.input,
      status: "in_review",
      createdAt: at,
      updatedAt: at,
      history: [
        { at, actor: input.requestingAgent, action: "proposed", detail: input.requestedAction },
        { at, actor: input.requestingAgent, action: "submitted_for_review" },
      ],
    };
    return this.store.put(item);
  }

  async approve(
    itemId: string,
    opts: { reviewer: string; reviewerRole: string; ttlMs?: number },
  ): Promise<WorkItem | null> {
    const item = await this.store.get(itemId);
    if (!item) return null;
    const at = now();
    const expiresAt = at + (opts.ttlMs ?? 15 * 60_000);
    return this.store.patch(itemId, {
      status: "approved",
      reviewer: opts.reviewer,
      reviewerRole: opts.reviewerRole,
      approvedAt: at,
      expiresAt,
      consumed: false,
      history: [
        ...item.history,
        { at, actor: opts.reviewer, action: "approved", detail: `role=${opts.reviewerRole}` },
      ],
    });
  }

  async reject(itemId: string, opts: { reviewer: string; reason?: string }): Promise<WorkItem | null> {
    const item = await this.store.get(itemId);
    if (!item) return null;
    const at = now();
    return this.store.patch(itemId, {
      status: "rejected",
      reviewer: opts.reviewer,
      history: [...item.history, { at, actor: opts.reviewer, action: "rejected", detail: opts.reason }],
    });
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
        history: [...item.history, { at: now(), actor: "system", action: "expired" }],
      }))!;
    }

    const gate = evaluateGate(item, attempt);
    if (!gate.ok) {
      await this.store.patch(itemId, {
        history: [...item.history, { at: now(), actor: attempt.agentId, action: "execution_denied", detail: gate.reason }],
      });
      return { ok: false, item, gate };
    }

    const result = await executor(item);
    const at = now();
    const updated = await this.store.patch(itemId, {
      status: "executed",
      consumed: true,
      executedAt: at,
      result,
      history: [...item.history, { at, actor: attempt.agentId, action: "executed", detail: result }],
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
