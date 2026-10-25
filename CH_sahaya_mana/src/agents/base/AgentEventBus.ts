import { z } from "zod";
import { newId } from "@/lib/ids";
import type { AgentStore } from "./AgentStore";
import { AgentError, toErrorMessage } from "./errors";
import type { AgentContext, AgentEvent, AgentId } from "./types";

/** An event an agent is allowed to send. The payload schema is the allow-list of fields. */
export interface OutboundEventContract {
  type: string;
  target: AgentId;
  description: string;
  payload: z.ZodObject;
}

/** An event an agent is willing to receive, and from whom. */
export interface InboundEventContract {
  type: string;
  from: AgentId[];
  description: string;
  payload: z.ZodObject;
}

export interface AgentEventContracts {
  outbound: OutboundEventContract[];
  inbound: InboundEventContract[];
}

/** Delivers an accepted event to its target. In-process for tests; Convex scheduler in production. */
export type EventDispatcher = (event: AgentEvent) => Promise<{ taskId?: string } | void>;

const MAX_PAYLOAD_BYTES = 4096;
/** Defense in depth: conversation material must never cross agent boundaries. */
const FORBIDDEN_PAYLOAD_KEYS = ["history", "messages", "conversation", "transcript", "memory", "content"];

function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(k.toLowerCase())) return k;
    const nested = findForbiddenKey(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Controlled channel for cross-agent collaboration. An event is accepted only if:
 *  1. the source declared it as outbound to that target,
 *  2. the target declared it accepts that type from that source,
 *  3. the payload passes both agents' strict schemas (no extra fields) and size limits,
 *  4. the user has enabled consent for that exact source→target→type route.
 * Every attempt — accepted or rejected — is persisted with its status for audit.
 */
export class AgentEventBus {
  private contracts = new Map<AgentId, AgentEventContracts>();
  private dispatcher: EventDispatcher | null = null;

  constructor(
    private readonly store: AgentStore,
    private readonly now: () => number = Date.now,
  ) {}

  registerAgent(agentId: AgentId, contracts: AgentEventContracts) {
    if (this.contracts.has(agentId)) throw new Error(`${agentId} already registered on event bus`);
    for (const c of contracts.outbound) {
      if (c.target === agentId) throw new Error(`${agentId} cannot declare an event to itself`);
    }
    this.contracts.set(agentId, contracts);
  }

  setDispatcher(dispatcher: EventDispatcher) {
    this.dispatcher = dispatcher;
  }

  /** All routes that both sides have declared — the set a user can grant consent for. */
  listRoutes(): Array<{ source: AgentId; target: AgentId; type: string; description: string }> {
    const routes = [];
    for (const [source, c] of this.contracts) {
      for (const out of c.outbound) {
        const inbound = this.contracts.get(out.target)?.inbound.find(
          (i) => i.type === out.type && i.from.includes(source),
        );
        if (inbound) routes.push({ source, target: out.target, type: out.type, description: out.description });
      }
    }
    return routes;
  }

  async publish(
    source: AgentId,
    target: AgentId,
    type: string,
    payload: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<AgentEvent> {
    const event: AgentEvent = {
      id: newId("evt"),
      sourceAgent: source,
      targetAgent: target,
      type,
      userId: ctx.userId,
      authorizedBy: ctx.actor.id,
      payload: {},
      timestamp: this.now(),
      correlationId: ctx.correlationId ?? newId("cor"),
      status: "pending",
    };

    const reject = async (code: "EVENT_REJECTED" | "CONSENT_REQUIRED", reason: string): Promise<never> => {
      await this.store.saveEvent({ ...event, status: "rejected", statusReason: reason });
      await this.log(source, event, "warn", `Event ${type} → ${target} rejected: ${reason}`);
      throw new AgentError(code, reason, { eventId: event.id });
    };

    if (source === target) return reject("EVENT_REJECTED", "agents cannot send events to themselves");

    const out = this.contracts.get(source)?.outbound.find((c) => c.type === type && c.target === target);
    if (!out) return reject("EVENT_REJECTED", `${source} has no outbound contract for ${type} → ${target}`);

    const inbound = this.contracts.get(target)?.inbound.find((c) => c.type === type);
    if (!inbound || !inbound.from.includes(source)) {
      return reject("EVENT_REJECTED", `${target} does not accept ${type} from ${source}`);
    }

    const forbidden = findForbiddenKey(payload);
    if (forbidden) return reject("EVENT_REJECTED", `payload field "${forbidden}" may not cross agent boundaries`);
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
      return reject("EVENT_REJECTED", `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }

    const outParsed = out.payload.strict().safeParse(payload);
    if (!outParsed.success) return reject("EVENT_REJECTED", `invalid payload: ${z.prettifyError(outParsed.error)}`);
    const inParsed = inbound.payload.strict().safeParse(outParsed.data);
    if (!inParsed.success) return reject("EVENT_REJECTED", `target rejected payload: ${z.prettifyError(inParsed.error)}`);

    const consent = await this.store.getConsent(ctx.userId, source, target, type);
    if (!consent?.enabled) {
      return reject("CONSENT_REQUIRED", `user has not enabled ${source} → ${target} "${type}"`);
    }

    const accepted: AgentEvent = { ...event, payload: inParsed.data as Record<string, unknown> };
    await this.store.saveEvent(accepted);
    await this.log(source, accepted, "info", `Sent ${type} → ${target}`);

    if (!this.dispatcher) return accepted;
    const delivered: AgentEvent = { ...accepted, status: "delivered" };
    await this.store.saveEvent(delivered);
    try {
      const result = await this.dispatcher(delivered);
      const handled: AgentEvent = { ...delivered, status: "handled", resultTaskId: result?.taskId };
      await this.store.saveEvent(handled);
      return handled;
    } catch (err) {
      const failed: AgentEvent = { ...delivered, status: "failed", statusReason: toErrorMessage(err) };
      await this.store.saveEvent(failed);
      await this.log(target, failed, "error", `Handling ${type} from ${source} failed: ${toErrorMessage(err)}`);
      return failed;
    }
  }

  private log(agentId: AgentId, event: AgentEvent, level: "info" | "warn" | "error", message: string) {
    return this.store.appendLog({
      id: newId("log"),
      agentId,
      userId: event.userId,
      kind: "event",
      level,
      message,
      data: { eventId: event.id, type: event.type, source: event.sourceAgent, target: event.targetAgent },
      correlationId: event.correlationId,
      at: this.now(),
    });
  }
}
