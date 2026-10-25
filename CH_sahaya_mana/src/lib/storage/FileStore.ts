import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, type MemoryStoreSnapshot } from "@/agents/base/MemoryStore";
import type { AgentStore } from "@/agents/base/AgentStore";

/**
 * Durable LOCAL development store: the same AgentStore behaviour as MemoryStore (so per-agent isolation,
 * namespaces, approvals and logs are unchanged), saved to one JSON file after every write.
 *  - atomic: written to a temp file and renamed; file mode 600 (owner read/write only)
 *  - meant for `next dev` on one computer; it is NOT Convex and NOT shared between machines
 * Convex (ConvexStore) is the production target and needs the owner's OK to deploy functions.
 */
const MUTATORS = [
  "appendMessage",
  "putMemory",
  "deleteMemory",
  "saveTask",
  "saveApproval",
  "consumeApproval",
  "transitionApproval",
  "redactConversation",
  "appendLog",
  "saveEvent",
  "saveJob",
  "setConsent",
  "setSharedAccess",
  "setSharedData",
  "setCaregiverPermission",
] as const satisfies ReadonlyArray<keyof AgentStore>;

export class FileStore extends MemoryStore {
  private dirty = false;

  constructor(readonly path: string) {
    super();
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      if (raw.trim()) this.loadSnapshot(JSON.parse(raw) as MemoryStoreSnapshot);
    }
    for (const name of MUTATORS) {
      const original = (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name].bind(this);
      (this as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name] = async (...args: unknown[]) => {
        const result = await original(...args);
        this.dirty = true;
        this.flush();
        return result;
      };
    }
  }

  /** Synchronous, atomic write of the current state (called after each write; cheap at local-dev sizes). */
  flush() {
    if (!this.dirty) return;
    this.trimLogs();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toSnapshot()), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.dirty = false;
  }
}
