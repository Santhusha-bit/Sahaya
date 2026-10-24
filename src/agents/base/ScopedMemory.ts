import { id, now } from "@/lib/id";
import { AGENT_PERMISSIONS } from "./policy";
import type { AgentId, MemoryRecord, MemoryStore, ScopedMemory } from "./types";

/**
 * A memory handle bound to one agent + one user. It physically cannot address
 * another agent's namespace: every write forces `namespace = this.agentId`, and
 * every read queries that same namespace. Shared household memory is reachable
 * only when the agent holds the matching permission in AGENT_PERMISSIONS.
 *
 * This is the core of agent memory isolation (prompt §4).
 */
export class ScopedMemoryImpl implements ScopedMemory {
  constructor(
    private readonly store: MemoryStore,
    public readonly agentId: AgentId,
    public readonly userId: string,
  ) {}

  async save(collection: string, data: Record<string, unknown>, opts?: { tags?: string[] }): Promise<MemoryRecord> {
    const rec: MemoryRecord = {
      id: id("mem"),
      namespace: this.agentId,
      collection,
      userId: this.userId,
      data,
      tags: opts?.tags,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.put(rec);
  }

  async list(collection: string, opts?: { tag?: string; limit?: number }): Promise<MemoryRecord[]> {
    return this.store.list({
      namespace: this.agentId,
      userId: this.userId,
      collection,
      tag: opts?.tag,
      limit: opts?.limit,
    });
  }

  async get(recordId: string): Promise<MemoryRecord | null> {
    const rec = await this.store.get(recordId);
    // Defensive: never hand back a record from another namespace or user.
    if (!rec || rec.namespace !== this.agentId || rec.userId !== this.userId) return null;
    return rec;
  }

  async update(recordId: string, data: Record<string, unknown>): Promise<MemoryRecord | null> {
    const existing = await this.get(recordId);
    if (!existing) return null;
    return this.store.patch(recordId, data);
  }

  async remove(recordId: string): Promise<boolean> {
    const existing = await this.get(recordId);
    if (!existing) return false;
    return this.store.remove(recordId);
  }

  async readShared(collection: string, opts?: { limit?: number }): Promise<MemoryRecord[]> {
    if (!AGENT_PERMISSIONS[this.agentId].sharedRead) {
      throw new PermissionError(`${this.agentId} is not permitted to read shared memory.`);
    }
    return this.store.list({
      namespace: "shared",
      userId: this.userId,
      collection,
      limit: opts?.limit,
    });
  }

  async writeShared(collection: string, data: Record<string, unknown>): Promise<MemoryRecord> {
    if (!AGENT_PERMISSIONS[this.agentId].sharedWrite) {
      throw new PermissionError(`${this.agentId} is not permitted to write shared memory.`);
    }
    const rec: MemoryRecord = {
      id: id("mem"),
      namespace: "shared",
      collection,
      userId: this.userId,
      data,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.put(rec);
  }
}

export class PermissionError extends Error {
  readonly code = "permission_denied";
}
