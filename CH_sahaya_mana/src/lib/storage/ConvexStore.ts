import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { AgentError } from "@/agents/base/errors";
import type { AgentStore, ApprovalExpectation, ApprovalFilter, ApprovalTransition, EventFilter, LogFilter, TaskFilter } from "@/agents/base/AgentStore";
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
} from "@/agents/base/types";

/**
 * AgentStore backed by the Convex functions in convex/agentStore.ts. One instance per request, authenticated with
 * that person's Auth0 ID token (verified by Convex). Nothing here decides identity: Convex derives the caller from
 * the token and checks every userId. Failures surface as STORAGE_UNAVAILABLE / UNAUTHENTICATED / PERMISSION_DENIED —
 * never a silent switch to local storage. Writes aren't retried here; the functions are idempotent upserts by id.
 */
const api = anyApi.agentStore;

type Ref = (typeof api)[string];

/** Drop undefined fields so Convex validators see exactly the declared shape. */
function clean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

export class ConvexStore implements AgentStore {
  private readonly client: ConvexHttpClient;

  constructor(url: string, token: string, opts: { fetch?: typeof fetch } = {}) {
    this.client = new ConvexHttpClient(url, { logger: false, auth: token, fetch: opts.fetch });
  }

  private async call<T>(kind: "query" | "mutation", ref: Ref, args: object): Promise<T> {
    try {
      return (kind === "query" ? await this.client.query(ref, args as Record<string, unknown>) : await this.client.mutation(ref, args as Record<string, unknown>)) as T;
    } catch (err) {
      if (err instanceof ConvexError) {
        const code = (err.data as { code?: string } | undefined)?.code;
        if (code === "UNAUTHENTICATED") throw new AgentError("UNAUTHENTICATED", "Your sign-in has expired. Please sign in again.");
        if (code === "FORBIDDEN") throw new AgentError("PERMISSION_DENIED", "Not allowed.");
        if (code === "VALIDATION") throw new AgentError("VALIDATION_FAILED", "The data couldn't be saved (validation).");
        if (code === "NOT_FOUND") throw new AgentError("NOT_FOUND", "Not found.");
      }
      const msg = err instanceof Error ? err.message : "";
      if (/unauthenticated|could not verify|invalid token|token.*expired|no auth provider/i.test(msg)) {
        throw new AgentError("UNAUTHENTICATED", "Your sign-in couldn't be verified by the database. Please sign in again.");
      }
      throw new AgentError("STORAGE_UNAVAILABLE", "The secure database couldn't be reached, so nothing was saved. Please try again in a moment.");
    }
  }
  private q<T>(ref: Ref, args: object) {
    return this.call<T>("query", ref, args);
  }
  private m<T>(ref: Ref, args: object) {
    return this.call<T>("mutation", ref, args);
  }

  appendMessage(msg: ConversationMessage) {
    return this.m<void>(api.appendMessage, { msg: clean(msg) });
  }
  listMessages(agentId: AgentId, userId: string, limit?: number) {
    return this.q<ConversationMessage[]>(api.listMessages, clean({ agentId, userId, limit }));
  }
  redactConversation(agentId: AgentId, userId: string, terms: string[], replacement?: string) {
    return this.m<number>(api.redactConversation, clean({ agentId, userId, terms, replacement }));
  }

  putMemory(rec: MemoryRecord) {
    return this.m<void>(api.putMemory, { rec: clean(rec) });
  }
  getMemory(agentId: AgentId, userId: string, namespace: string, key: string) {
    return this.q<MemoryRecord | null>(api.getMemory, { agentId, userId, namespace, key });
  }
  listMemory(agentId: AgentId, userId: string, namespace?: string) {
    return this.q<MemoryRecord[]>(api.listMemory, clean({ agentId, userId, namespace }));
  }
  deleteMemory(agentId: AgentId, userId: string, namespace: string, key: string) {
    return this.m<void>(api.deleteMemory, { agentId, userId, namespace, key });
  }

  saveTask(task: AgentTask) {
    return this.m<void>(api.saveTask, { task: clean(task) });
  }
  getTask(id: string) {
    return this.q<AgentTask | null>(api.getTask, { id });
  }
  listTasks(filter: TaskFilter) {
    return this.q<AgentTask[]>(api.listTasks, clean(filter));
  }

  saveApproval(a: ApprovalRequest) {
    return this.m<void>(api.saveApproval, { approval: clean(a) });
  }
  getApproval(id: string) {
    return this.q<ApprovalRequest | null>(api.getApproval, { id });
  }
  consumeApproval(id: string, expect?: ApprovalExpectation) {
    // Expiry is checked with the database's clock inside the same transaction.
    return this.m<boolean>(api.consumeApproval, clean({ id, expect: expect && { userId: expect.userId, toolName: expect.toolName, inputHash: expect.inputHash } }));
  }
  transitionApproval(id: string, from: ApprovalStatus, patch: ApprovalTransition) {
    return this.m<boolean>(api.transitionApproval, { id, from, to: patch.status });
  }
  listApprovals(filter: ApprovalFilter) {
    return this.q<ApprovalRequest[]>(api.listApprovals, clean(filter));
  }

  appendLog(log: ExecutionLog) {
    return this.m<void>(api.appendLog, { log: clean(log) });
  }
  listLogs(filter: LogFilter) {
    return this.q<ExecutionLog[]>(api.listLogs, clean(filter));
  }

  saveEvent(e: AgentEvent) {
    return this.m<void>(api.saveEvent, { event: clean(e) });
  }
  getEvent(id: string) {
    return this.q<AgentEvent | null>(api.getEvent, { id });
  }
  listEvents(filter: EventFilter) {
    return this.q<AgentEvent[]>(api.listEvents, clean(filter));
  }

  saveJob(job: ScheduledJob) {
    return this.m<void>(api.saveJob, { job: clean(job) });
  }
  getJob(id: string) {
    return this.q<ScheduledJob | null>(api.getJob, { id });
  }
  listJobs(userId: string, agentId?: AgentId) {
    return this.q<ScheduledJob[]>(api.listJobs, clean({ userId, agentId }));
  }
  listDueJobs(now: number) {
    return this.q<ScheduledJob[]>(api.listDueJobs, { now });
  }

  getConsent(userId: string, sourceAgent: AgentId, targetAgent: AgentId, eventType: string) {
    return this.q<ConsentGrant | null>(api.getConsent, { userId, sourceAgent, targetAgent, eventType });
  }
  setConsent(grant: ConsentGrant) {
    return this.m<void>(api.setConsent, { grant: clean(grant) });
  }
  listConsents(userId: string) {
    return this.q<ConsentGrant[]>(api.listConsents, { userId });
  }

  getSharedAccess(userId: string, agentId: AgentId, key: SharedDataKey) {
    return this.q<SharedAccessGrant | null>(api.getSharedAccess, { userId, agentId, key });
  }
  setSharedAccess(grant: SharedAccessGrant) {
    return this.m<void>(api.setSharedAccess, { grant: clean(grant) });
  }
  getSharedData(userId: string, key: SharedDataKey) {
    return this.q<unknown>(api.getSharedData, { userId, key });
  }
  setSharedData(userId: string, key: SharedDataKey, value: unknown) {
    return this.m<void>(api.setSharedData, { userId, key, value: clean(value) });
  }

  getCaregiverPermission(userId: string, caregiverId: string, agentId: AgentId) {
    return this.q<CaregiverPermission | null>(api.getCaregiverPermission, { userId, caregiverId, agentId });
  }
  setCaregiverPermission(p: CaregiverPermission) {
    return this.m<void>(api.setCaregiverPermission, { perm: clean(p) });
  }
  listGrantsForOwner(userId: string) {
    return this.q<CaregiverPermission[]>(api.listGrantsForOwner, { userId });
  }
  listGrantsForCaregiver(caregiverId: string) {
    return this.q<CaregiverPermission[]>(api.listGrantsForCaregiver, { caregiverId });
  }
}
