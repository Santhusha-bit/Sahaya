import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { newId } from "@/lib/ids";
import type { ScopedAgentStore } from "../../base/AgentStore";
import type { AgentEvent, AgentId, LogKind } from "../../base/types";
import type { CareAdapters } from "../adapters";
import { createSandboxAdapters } from "../adapters";
import { CareRepo } from "../repository";

/** Everything a Care service needs, built from the agent's own scoped capabilities. */
export interface CareEnv {
  repo: CareRepo;
  adapters: CareAdapters;
  store: ScopedAgentStore;
  now: () => number;
  integrationMode: (id: IntegrationId) => IntegrationMode;
  /** Publish through the event bus with Care pinned as the source (schema + route + consent checked there). */
  emit: (target: AgentId, type: string, payload: Record<string, unknown>) => Promise<AgentEvent>;
  /** Audit log entry. Pass ids and categories only — never medication names, allergies or free text. */
  audit: (userId: string, kind: LogKind, message: string, data?: Record<string, unknown>, level?: "info" | "warn" | "error") => Promise<void>;
}

export function createCareEnv(opts: {
  store: ScopedAgentStore;
  now: () => number;
  integrationMode: (id: IntegrationId) => IntegrationMode;
  emit: CareEnv["emit"];
  correlationId?: string;
}): CareEnv {
  const repo = new CareRepo(opts.store, opts.now);
  return {
    repo,
    adapters: createSandboxAdapters(repo, opts.now, opts.integrationMode("voice") === "live" ? "live" : "sandbox"),
    store: opts.store,
    now: opts.now,
    integrationMode: opts.integrationMode,
    emit: opts.emit,
    audit: (userId, kind, message, data, level = "info") =>
      opts.store.appendLog({
        id: newId("log"),
        userId,
        kind,
        level,
        message,
        data,
        correlationId: opts.correlationId,
        at: opts.now(),
      }),
  };
}
