import { AgentError } from "./errors";
import type {
  AgentEvent,
  AgentId,
  AgentTask,
  ApprovalRequest,
  ApprovalStatus,
  CaregiverPermission,
  ConsentGrant,
  ConversationMessage,
  ExecutionLog,
  MemoryRecord,
  ScheduledJob,
  SharedAccessGrant,
  SharedDataKey,
} from "./types";

export interface TaskFilter {
  agentId?: AgentId;
  userId: string;
  status?: AgentTask["status"][];
  limit?: number;
}

export interface ApprovalFilter {
  agentId?: AgentId;
  userId: string;
  status?: ApprovalRequest["status"][];
}

export interface LogFilter {
  agentId?: AgentId;
  userId: string;
  correlationId?: string;
  limit?: number;
}

export interface ApprovalExpectation {
  userId: string;
  toolName: string;
  inputHash: string;
  now: number;
}

export interface ApprovalTransition {
  status: ApprovalStatus;
  decidedAt?: number;
  decidedBy?: string;
  /** Reject approving if the approval expired before this time. */
  now?: number;
}

export interface EventFilter {
  userId: string;
  agentId?: AgentId;
  correlationId?: string;
  limit?: number;
}

/**
 * Privileged persistence interface. Only the AgentRuntime and the event bus hold this.
 * Agents receive a ScopedAgentStore, which pins every call to their own agentId.
 * Implementations: MemoryStore (tests/dev), ConvexStore (M1).
 */
export interface AgentStore {
  appendMessage(msg: ConversationMessage): Promise<void>;
  listMessages(agentId: AgentId, userId: string, limit?: number): Promise<ConversationMessage[]>;

  putMemory(rec: MemoryRecord): Promise<void>;
  getMemory(agentId: AgentId, userId: string, namespace: string, key: string): Promise<MemoryRecord | null>;
  listMemory(agentId: AgentId, userId: string, namespace?: string): Promise<MemoryRecord[]>;
  deleteMemory(agentId: AgentId, userId: string, namespace: string, key: string): Promise<void>;

  saveTask(task: AgentTask): Promise<void>;
  getTask(id: string): Promise<AgentTask | null>;
  listTasks(filter: TaskFilter): Promise<AgentTask[]>;

  saveApproval(a: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  /**
   * Atomic compare-and-set: marks an `approved` approval `consumed` and returns true, or returns false
   * if it was not `approved` at that instant (already used, denied, expired). Single-use enforcement.
   * When `expect` is given, the same transaction also checks owner, tool, input hash and expiry.
   */
  consumeApproval(id: string, expect?: ApprovalExpectation): Promise<boolean>;
  /**
   * Atomic decision: moves an approval from `from` to `patch.status` only if it is still `from`, and (when
   * approving) not expired. Returns false if another request decided it first. Prevents approve/deny races.
   */
  transitionApproval(id: string, from: ApprovalStatus, patch: ApprovalTransition): Promise<boolean>;
  listApprovals(filter: ApprovalFilter): Promise<ApprovalRequest[]>;

  /**
   * Replace forgotten values inside one agent's stored conversation with a user: message text and content blocks,
   * plus task titles/step outputs/results/errors (which echo the conversation). Returns the number of records changed.
   */
  redactConversation(agentId: AgentId, userId: string, terms: string[], replacement?: string): Promise<number>;

  appendLog(log: ExecutionLog): Promise<void>;
  listLogs(filter: LogFilter): Promise<ExecutionLog[]>;

  saveEvent(e: AgentEvent): Promise<void>;
  getEvent(id: string): Promise<AgentEvent | null>;
  listEvents(filter: EventFilter): Promise<AgentEvent[]>;

  saveJob(job: ScheduledJob): Promise<void>;
  getJob(id: string): Promise<ScheduledJob | null>;
  listJobs(userId: string, agentId?: AgentId): Promise<ScheduledJob[]>;
  listDueJobs(now: number): Promise<ScheduledJob[]>;

  getConsent(userId: string, source: AgentId, target: AgentId, eventType: string): Promise<ConsentGrant | null>;
  setConsent(grant: ConsentGrant): Promise<void>;
  listConsents(userId: string): Promise<ConsentGrant[]>;

  getSharedAccess(userId: string, agentId: AgentId, key: SharedDataKey): Promise<SharedAccessGrant | null>;
  setSharedAccess(grant: SharedAccessGrant): Promise<void>;
  getSharedData(userId: string, key: SharedDataKey): Promise<unknown>;
  setSharedData(userId: string, key: SharedDataKey, value: unknown): Promise<void>;

  getCaregiverPermission(userId: string, caregiverId: string, agentId: AgentId): Promise<CaregiverPermission | null>;
  /** All grants a person has given, including revoked/expired ones (owner view). */
  listGrantsForOwner(userId: string): Promise<CaregiverPermission[]>;
  /** Active grants given TO this caregiver — the only way a caregiver finds whom they may view. */
  listGrantsForCaregiver(caregiverId: string): Promise<CaregiverPermission[]>;
  setCaregiverPermission(p: CaregiverPermission): Promise<void>;
}

/**
 * The only store handle an agent ever sees. Every read and write is pinned to one agentId,
 * memory access is limited to that agent's declared namespaces, and shared household data
 * requires an explicit per-agent grant. Records owned by another agent raise ISOLATION_VIOLATION.
 */
export class ScopedAgentStore {
  constructor(
    private readonly root: AgentStore,
    readonly agentId: AgentId,
    private readonly namespaces: readonly string[],
  ) {}

  private assertNamespace(namespace: string) {
    if (!this.namespaces.includes(namespace)) {
      throw new AgentError(
        "ISOLATION_VIOLATION",
        `${this.agentId} agent may not access memory namespace "${namespace}"`,
      );
    }
  }

  private assertOwned<T extends { agentId: AgentId }>(record: T | null, kind: string, id: string): T {
    if (!record) throw new AgentError("NOT_FOUND", `${kind} ${id} not found`);
    if (record.agentId !== this.agentId) {
      throw new AgentError("ISOLATION_VIOLATION", `${kind} ${id} belongs to another agent`);
    }
    return record;
  }

  get memoryNamespaces(): readonly string[] {
    return this.namespaces;
  }

  // Conversation
  async appendMessage(msg: Omit<ConversationMessage, "agentId">) {
    return this.root.appendMessage({ ...msg, agentId: this.agentId });
  }
  async listMessages(userId: string, limit?: number) {
    return this.root.listMessages(this.agentId, userId, limit);
  }

  // Memory
  async putMemory(rec: Omit<MemoryRecord, "agentId">) {
    this.assertNamespace(rec.namespace);
    return this.root.putMemory({ ...rec, agentId: this.agentId });
  }
  async getMemory(userId: string, namespace: string, key: string) {
    this.assertNamespace(namespace);
    return this.root.getMemory(this.agentId, userId, namespace, key);
  }
  async listMemory(userId: string, namespace?: string) {
    if (namespace) this.assertNamespace(namespace);
    return this.root.listMemory(this.agentId, userId, namespace);
  }
  async deleteMemory(userId: string, namespace: string, key: string) {
    this.assertNamespace(namespace);
    return this.root.deleteMemory(this.agentId, userId, namespace, key);
  }

  // Tasks
  async saveTask(task: AgentTask) {
    if (task.agentId !== this.agentId) {
      throw new AgentError("ISOLATION_VIOLATION", "cannot save a task for another agent");
    }
    return this.root.saveTask(task);
  }
  async getTask(id: string) {
    return this.assertOwned(await this.root.getTask(id), "Task", id);
  }
  async listTasks(filter: Omit<TaskFilter, "agentId">) {
    return this.root.listTasks({ ...filter, agentId: this.agentId });
  }

  // Approvals
  async saveApproval(a: ApprovalRequest) {
    if (a.agentId !== this.agentId) {
      throw new AgentError("ISOLATION_VIOLATION", "cannot save an approval for another agent");
    }
    return this.root.saveApproval(a);
  }
  async getApproval(id: string) {
    return this.assertOwned(await this.root.getApproval(id), "Approval", id);
  }
  async listApprovals(filter: Omit<ApprovalFilter, "agentId">) {
    return this.root.listApprovals({ ...filter, agentId: this.agentId });
  }
  async consumeApproval(id: string, expect?: ApprovalExpectation): Promise<boolean> {
    this.assertOwned(await this.root.getApproval(id), "Approval", id);
    return this.root.consumeApproval(id, expect);
  }
  async transitionApproval(id: string, from: ApprovalStatus, patch: ApprovalTransition): Promise<boolean> {
    this.assertOwned(await this.root.getApproval(id), "Approval", id);
    return this.root.transitionApproval(id, from, patch);
  }

  // Forgetting: redaction is pinned to this agent's own conversation with the user.
  async redactConversation(userId: string, terms: string[], replacement?: string) {
    return this.root.redactConversation(this.agentId, userId, terms, replacement);
  }

  // Logs
  async appendLog(log: Omit<ExecutionLog, "agentId">) {
    return this.root.appendLog({ ...log, agentId: this.agentId });
  }
  async listLogs(filter: Omit<LogFilter, "agentId">) {
    return this.root.listLogs({ ...filter, agentId: this.agentId });
  }

  // Scheduled jobs
  async saveJob(job: ScheduledJob) {
    if (job.agentId !== this.agentId) {
      throw new AgentError("ISOLATION_VIOLATION", "cannot schedule a job for another agent");
    }
    return this.root.saveJob(job);
  }
  async getJob(id: string) {
    return this.assertOwned(await this.root.getJob(id), "Job", id);
  }
  async listJobs(userId: string) {
    return this.root.listJobs(userId, this.agentId);
  }

  // Shared household data — read-only, grant-gated
  async readShared<T = unknown>(userId: string, key: SharedDataKey): Promise<T | null> {
    const grant = await this.root.getSharedAccess(userId, this.agentId, key);
    if (!grant?.enabled) {
      throw new AgentError(
        "PERMISSION_DENIED",
        `${this.agentId} agent has no permission to read shared "${key}"`,
      );
    }
    return ((await this.root.getSharedData(userId, key)) as T) ?? null;
  }
}
