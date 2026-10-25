import type { AgentStore, ApprovalExpectation, ApprovalFilter, ApprovalTransition, EventFilter, LogFilter, TaskFilter } from "./AgentStore";
import { buildRedactor, redactDeep } from "./redact";
import { grantActive, grantLive } from "../care/accessRules";
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

const clone = <T>(v: T): T => structuredClone(v);

/** Plain-JSON image of a MemoryStore (used by the durable local FileStore). */
export interface MemoryStoreSnapshot {
  version: 1;
  messages: ConversationMessage[];
  memory: Array<[string, MemoryRecord]>;
  tasks: Array<[string, AgentTask]>;
  approvals: Array<[string, ApprovalRequest]>;
  logs: ExecutionLog[];
  events: Array<[string, AgentEvent]>;
  jobs: Array<[string, ScheduledJob]>;
  consents: Array<[string, ConsentGrant]>;
  sharedAccess: Array<[string, SharedAccessGrant]>;
  sharedData: Array<[string, unknown]>;
  caregiverPerms: Array<[string, CaregiverPermission]>;
}

/** In-process AgentStore for tests and keyless local dev. Not durable on its own. */
export class MemoryStore implements AgentStore {
  private messages: ConversationMessage[] = [];
  private memory = new Map<string, MemoryRecord>();
  private tasks = new Map<string, AgentTask>();
  private approvals = new Map<string, ApprovalRequest>();
  private logs: ExecutionLog[] = [];
  private events = new Map<string, AgentEvent>();
  private jobs = new Map<string, ScheduledJob>();
  private consents = new Map<string, ConsentGrant>();
  private sharedAccess = new Map<string, SharedAccessGrant>();
  private sharedData = new Map<string, unknown>();
  private caregiverPerms = new Map<string, CaregiverPermission>();

  async appendMessage(msg: ConversationMessage) {
    this.messages.push(clone(msg));
  }
  async listMessages(agentId: AgentId, userId: string, limit = 200) {
    return clone(this.messages.filter((m) => m.agentId === agentId && m.userId === userId).slice(-limit));
  }

  private memKey(agentId: AgentId, userId: string, ns: string, key: string) {
    return `${agentId}|${userId}|${ns}|${key}`;
  }
  async putMemory(rec: MemoryRecord) {
    this.memory.set(this.memKey(rec.agentId, rec.userId, rec.namespace, rec.key), clone(rec));
  }
  async getMemory(agentId: AgentId, userId: string, namespace: string, key: string) {
    const rec = this.memory.get(this.memKey(agentId, userId, namespace, key));
    return rec ? clone(rec) : null;
  }
  async listMemory(agentId: AgentId, userId: string, namespace?: string) {
    return clone(
      [...this.memory.values()].filter(
        (r) => r.agentId === agentId && r.userId === userId && (!namespace || r.namespace === namespace),
      ),
    );
  }
  async deleteMemory(agentId: AgentId, userId: string, namespace: string, key: string) {
    this.memory.delete(this.memKey(agentId, userId, namespace, key));
  }

  async saveTask(task: AgentTask) {
    this.tasks.set(task.id, clone(task));
  }
  async getTask(id: string) {
    const t = this.tasks.get(id);
    return t ? clone(t) : null;
  }
  async listTasks(f: TaskFilter) {
    return clone(
      [...this.tasks.values()]
        .filter(
          (t) =>
            t.userId === f.userId &&
            (!f.agentId || t.agentId === f.agentId) &&
            (!f.status || f.status.includes(t.status)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, f.limit ?? 100),
    );
  }

  async saveApproval(a: ApprovalRequest) {
    this.approvals.set(a.id, clone(a));
  }
  async getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? clone(a) : null;
  }
  async consumeApproval(id: string, expect?: ApprovalExpectation) {
    // No await between the check and the write: atomic within the JS event loop.
    const a = this.approvals.get(id);
    if (!a || a.status !== "approved") return false;
    if (expect && (a.userId !== expect.userId || a.toolName !== expect.toolName || a.inputHash !== expect.inputHash || a.expiresAt < expect.now)) {
      return false;
    }
    this.approvals.set(id, { ...a, status: "consumed" });
    return true;
  }
  async transitionApproval(id: string, from: ApprovalStatus, patch: ApprovalTransition) {
    const a = this.approvals.get(id);
    if (!a || a.status !== from) return false;
    if (patch.status === "approved" && patch.now !== undefined && a.expiresAt < patch.now) {
      this.approvals.set(id, { ...a, status: "expired" });
      return false;
    }
    this.approvals.set(id, { ...a, status: patch.status, decidedAt: patch.decidedAt ?? a.decidedAt, decidedBy: patch.decidedBy ?? a.decidedBy });
    return true;
  }
  async redactConversation(agentId: AgentId, userId: string, terms: string[], replacement?: string) {
    const redact = buildRedactor(terms, replacement);
    if (!redact) return 0;
    let n = 0;
    this.messages = this.messages.map((m) => {
      if (m.agentId !== agentId || m.userId !== userId) return m;
      const [content, c1] = redactDeep(m.content, redact);
      const text = redact(m.text);
      if (!c1 && text === m.text) return m;
      n++;
      return { ...m, content: content as ConversationMessage["content"], text };
    });
    // Task titles and step outputs echo what was said and what tools returned.
    for (const [key, t] of this.tasks) {
      if (t.agentId !== agentId || t.userId !== userId) continue;
      const title = redact(t.title);
      const [steps, c] = redactDeep(t.steps, redact);
      const [result, c2] = redactDeep(t.result, redact);
      const error = t.error === undefined ? undefined : redact(t.error);
      if (title !== t.title || c || c2 || error !== t.error) {
        this.tasks.set(key, { ...t, title, steps: steps as AgentTask["steps"], result, error });
        n++;
      }
    }
    return n;
  }
  async listApprovals(f: ApprovalFilter) {
    return clone(
      [...this.approvals.values()]
        .filter(
          (a) =>
            a.userId === f.userId &&
            (!f.agentId || a.agentId === f.agentId) &&
            (!f.status || f.status.includes(a.status)),
        )
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  async appendLog(log: ExecutionLog) {
    this.logs.push(clone(log));
  }
  async listLogs(f: LogFilter) {
    return clone(
      this.logs
        .filter(
          (l) =>
            l.userId === f.userId &&
            (!f.agentId || l.agentId === f.agentId) &&
            (!f.correlationId || l.correlationId === f.correlationId),
        )
        .slice(-(f.limit ?? 200)),
    );
  }

  async saveEvent(e: AgentEvent) {
    this.events.set(e.id, clone(e));
  }
  async getEvent(id: string) {
    const e = this.events.get(id);
    return e ? clone(e) : null;
  }
  async listEvents(f: EventFilter) {
    return clone(
      [...this.events.values()]
        .filter(
          (e) =>
            e.userId === f.userId &&
            (!f.agentId || e.sourceAgent === f.agentId || e.targetAgent === f.agentId) &&
            (!f.correlationId || e.correlationId === f.correlationId),
        )
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, f.limit ?? 100),
    );
  }

  async saveJob(job: ScheduledJob) {
    this.jobs.set(job.id, clone(job));
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }
  async listJobs(userId: string, agentId?: AgentId) {
    return clone([...this.jobs.values()].filter((j) => j.userId === userId && (!agentId || j.agentId === agentId)));
  }
  async listDueJobs(now: number) {
    return clone([...this.jobs.values()].filter((j) => j.status === "scheduled" && j.runAt <= now));
  }

  private consentKey(userId: string, s: AgentId, t: AgentId, type: string) {
    return `${userId}|${s}|${t}|${type}`;
  }
  async getConsent(userId: string, source: AgentId, target: AgentId, eventType: string) {
    const g = this.consents.get(this.consentKey(userId, source, target, eventType));
    return g ? clone(g) : null;
  }
  async setConsent(grant: ConsentGrant) {
    this.consents.set(
      this.consentKey(grant.userId, grant.sourceAgent, grant.targetAgent, grant.eventType),
      clone(grant),
    );
  }
  async listConsents(userId: string) {
    return clone([...this.consents.values()].filter((g) => g.userId === userId));
  }

  async getSharedAccess(userId: string, agentId: AgentId, key: SharedDataKey) {
    const g = this.sharedAccess.get(`${userId}|${agentId}|${key}`);
    return g ? clone(g) : null;
  }
  async setSharedAccess(grant: SharedAccessGrant) {
    this.sharedAccess.set(`${grant.userId}|${grant.agentId}|${grant.key}`, clone(grant));
  }
  async getSharedData(userId: string, key: SharedDataKey) {
    const v = this.sharedData.get(`${userId}|${key}`);
    return v === undefined ? null : clone(v);
  }
  async setSharedData(userId: string, key: SharedDataKey, value: unknown) {
    this.sharedData.set(`${userId}|${key}`, clone(value));
  }

  async getCaregiverPermission(userId: string, caregiverId: string, agentId: AgentId) {
    const p = this.caregiverPerms.get(`${userId}|${caregiverId}|${agentId}`);
    // Revoked or expired grants are kept for the audit trail but read as "no grant".
    return p && grantLive(p, Date.now()) ? clone(p) : null;
  }
  async listGrantsForOwner(userId: string) {
    return [...this.caregiverPerms.values()].filter((p) => p.userId === userId).map(clone);
  }
  async listGrantsForCaregiver(caregiverId: string) {
    return [...this.caregiverPerms.values()].filter((p) => p.caregiverId === caregiverId && grantActive(p, Date.now())).map(clone);
  }
  async setCaregiverPermission(p: CaregiverPermission) {
    const key = `${p.userId}|${p.caregiverId}|${p.agentId}`;
    const existing = this.caregiverPerms.get(key);
    const revoked = !p.canViewSummaries && !p.canApprove && !(p.scopes ?? []).length;
    if (revoked && !existing) return;
    this.caregiverPerms.set(key, clone({ ...p, grantedAt: revoked ? existing?.grantedAt : (p.grantedAt ?? Date.now()), revokedAt: revoked ? Date.now() : undefined }));
  }

  /** Bounded so a long-running local store doesn't grow without limit (oldest logs dropped first). */
  protected trimLogs(max = 5000) {
    if (this.logs.length > max) this.logs = this.logs.slice(-max);
  }

  toSnapshot(): MemoryStoreSnapshot {
    return clone({
      version: 1 as const,
      messages: this.messages,
      memory: [...this.memory],
      tasks: [...this.tasks],
      approvals: [...this.approvals],
      logs: this.logs,
      events: [...this.events],
      jobs: [...this.jobs],
      consents: [...this.consents],
      sharedAccess: [...this.sharedAccess],
      sharedData: [...this.sharedData],
      caregiverPerms: [...this.caregiverPerms],
    });
  }

  protected loadSnapshot(s: MemoryStoreSnapshot) {
    if (s.version !== 1) throw new Error("unsupported store snapshot version");
    this.messages = s.messages ?? [];
    this.memory = new Map(s.memory ?? []);
    this.tasks = new Map(s.tasks ?? []);
    this.approvals = new Map(s.approvals ?? []);
    this.logs = s.logs ?? [];
    this.events = new Map(s.events ?? []);
    this.jobs = new Map(s.jobs ?? []);
    this.consents = new Map(s.consents ?? []);
    this.sharedAccess = new Map(s.sharedAccess ?? []);
    this.sharedData = new Map(s.sharedData ?? []);
    this.caregiverPerms = new Map(s.caregiverPerms ?? []);
  }
}
