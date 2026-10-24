import { id, now } from "@/lib/id";
import type { MemoryRecord, MemoryStore } from "./types";

/**
 * Append-only audit log (prompt global rule 5: "every step is audit-logged").
 *
 * Entries live in the shared memory namespace under the `audit` collection, so
 * every agent writes through the same abstraction and the trail is queryable in
 * one place (dashboard / demos). Each entry records who acted, what they did, the
 * correlation id tying a workflow together, and a small structured detail blob.
 */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  correlationId?: string;
  detail?: Record<string, unknown>;
  at: number;
}

const COLLECTION = "audit";

export class AuditLog {
  constructor(
    private readonly store: MemoryStore,
    private readonly userId: string,
  ) {}

  async record(entry: {
    actor: string;
    action: string;
    correlationId?: string;
    detail?: Record<string, unknown>;
  }): Promise<AuditEntry> {
    const row: AuditEntry = {
      id: id("audit"),
      actor: entry.actor,
      action: entry.action,
      correlationId: entry.correlationId,
      detail: entry.detail,
      at: now(),
    };
    await this.store.put({
      id: row.id,
      namespace: "shared",
      collection: COLLECTION,
      userId: this.userId,
      data: row as unknown as Record<string, unknown>,
      tags: ["audit", entry.actor],
      createdAt: row.at,
      updatedAt: row.at,
    });
    return row;
  }

  async list(opts?: { limit?: number }): Promise<AuditEntry[]> {
    const rows = await this.store.list({
      namespace: "shared",
      userId: this.userId,
      collection: COLLECTION,
      limit: opts?.limit ?? 200,
    });
    return rows
      .map((r: MemoryRecord) => r.data as unknown as AuditEntry)
      .sort((a, b) => a.at - b.at);
  }
}
