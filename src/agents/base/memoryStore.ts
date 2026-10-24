import type {
  AgentEvent,
  AgentTask,
  Approval,
  ApprovalStore,
  ConversationMessage,
  ConversationStore,
  DataLayer,
  EventQuery,
  EventStore,
  MemoryQuery,
  MemoryRecord,
  MemoryStore,
  TaskStore,
} from "./types";

/** In-process stores. Used for tests and whenever Convex is not configured. */

class InMemoryMemoryStore implements MemoryStore {
  private rows = new Map<string, MemoryRecord>();

  async put(rec: MemoryRecord) {
    this.rows.set(rec.id, rec);
    return rec;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async list(query: MemoryQuery) {
    let rows = [...this.rows.values()].filter(
      (r) => r.namespace === query.namespace && r.userId === query.userId,
    );
    if (query.collection) rows = rows.filter((r) => r.collection === query.collection);
    if (query.tag) rows = rows.filter((r) => r.tags?.includes(query.tag!));
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }
  async patch(id: string, data: Record<string, unknown>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, data: { ...row.data, ...data }, updatedAt: Date.now() };
    this.rows.set(id, next);
    return next;
  }
  async remove(id: string) {
    return this.rows.delete(id);
  }
}

class InMemoryEventStore implements EventStore {
  private rows = new Map<string, AgentEvent>();
  async put(evt: AgentEvent) {
    this.rows.set(evt.id, evt);
    return evt;
  }
  async list(query: EventQuery) {
    let rows = [...this.rows.values()].filter((e) => e.userId === query.userId);
    if (query.targetAgent) rows = rows.filter((e) => e.targetAgent === query.targetAgent);
    if (query.sourceAgent) rows = rows.filter((e) => e.sourceAgent === query.sourceAgent);
    if (query.correlationId) rows = rows.filter((e) => e.correlationId === query.correlationId);
    if (query.status) rows = rows.filter((e) => e.status === query.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }
  async patch(id: string, patch: Partial<AgentEvent>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }
}

class InMemoryTaskStore implements TaskStore {
  private rows = new Map<string, AgentTask>();
  async put(task: AgentTask) {
    this.rows.set(task.id, task);
    return task;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async list(query: { userId: string; agentId?: AgentId; limit?: number }) {
    let rows = [...this.rows.values()].filter((t) => t.userId === query.userId);
    if (query.agentId) rows = rows.filter((t) => t.agentId === query.agentId);
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }
  async patch(id: string, patch: Partial<AgentTask>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }
}

class InMemoryApprovalStore implements ApprovalStore {
  private rows = new Map<string, Approval>();
  async put(a: Approval) {
    this.rows.set(a.id, a);
    return a;
  }
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async list(query: { userId: string; agentId?: AgentId; status?: Approval["status"]; limit?: number }) {
    let rows = [...this.rows.values()].filter((a) => a.userId === query.userId);
    if (query.agentId) rows = rows.filter((a) => a.agentId === query.agentId);
    if (query.status) rows = rows.filter((a) => a.status === query.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }
  async patch(id: string, patch: Partial<Approval>) {
    const row = this.rows.get(id);
    if (!row) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }
}

class InMemoryConversationStore implements ConversationStore {
  private rows: ConversationMessage[] = [];
  async append(msg: ConversationMessage) {
    this.rows.push(msg);
    return msg;
  }
  async history(query: { userId: string; agentId: AgentId; limit?: number }) {
    const rows = this.rows
      .filter((m) => m.userId === query.userId && m.agentId === query.agentId)
      .sort((a, b) => a.createdAt - b.createdAt);
    return query.limit ? rows.slice(-query.limit) : rows;
  }
}

import type { AgentId } from "./types";

export function createInMemoryDataLayer(): DataLayer {
  return {
    memory: new InMemoryMemoryStore(),
    events: new InMemoryEventStore(),
    tasks: new InMemoryTaskStore(),
    approvals: new InMemoryApprovalStore(),
    conversations: new InMemoryConversationStore(),
    backend: "memory",
  };
}
