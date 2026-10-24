import { correlationId as newCorrelationId, now } from "@/lib/id";
import { id } from "@/lib/id";
import { CROSS_AGENT_RULES, DEFAULT_CONSENT, findRule } from "./policy";
import type { ConsentSettings } from "./policy";
import type { AgentEvent, AgentId, EventQuery, EventStore } from "./types";

export interface PublishInput {
  sourceAgent: AgentId;
  targetAgent: AgentId;
  type: string;
  userId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

export interface PublishResult {
  ok: boolean;
  event: AgentEvent;
  reason?: string;
}

/**
 * Controlled, event-driven cross-agent collaboration (prompt §5), backed by the
 * Convex (or in-process) event store. The bus is the ONLY channel between
 * agents and it enforces three things before an event is delivered:
 *
 *   1. There is an explicit rule in CROSS_AGENT_RULES for (source, target, type).
 *   2. The user has consented to that specific workflow.
 *   3. The payload validates against the rule's narrow schema — so whole private
 *      conversation histories can never be transmitted; only the permitted
 *      fields cross the boundary.
 *
 * A disallowed event is still recorded (status "blocked" / "rejected") for the
 * audit trail, but is never delivered to the target agent.
 */
export class AgentEventBus {
  constructor(
    private readonly store: EventStore,
    private readonly consent: ConsentSettings = DEFAULT_CONSENT,
  ) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const base: AgentEvent = {
      id: id("evt"),
      correlationId: input.correlationId ?? newCorrelationId(),
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      type: input.type,
      userId: input.userId,
      payload: {},
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
    };

    const rule = findRule(input.sourceAgent, input.targetAgent, input.type);
    if (!rule) {
      const event = await this.store.put({
        ...base,
        status: "blocked",
        reason: `No authorized workflow for ${input.sourceAgent} -> ${input.targetAgent} (${input.type}).`,
      });
      return { ok: false, event, reason: event.reason };
    }

    if (!this.consent[rule.consentKey]) {
      const event = await this.store.put({
        ...base,
        status: "blocked",
        reason: `User has not consented to the "${rule.consentKey}" workflow.`,
      });
      return { ok: false, event, reason: event.reason };
    }

    const parsed = rule.payload.safeParse(input.payload);
    if (!parsed.success) {
      const event = await this.store.put({
        ...base,
        status: "rejected",
        reason: `Payload rejected: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      });
      return { ok: false, event, reason: event.reason };
    }

    // Only the validated (narrow) payload is persisted and delivered.
    const event = await this.store.put({
      ...base,
      payload: parsed.data as Record<string, unknown>,
      status: "accepted",
    });
    return { ok: true, event };
  }

  async inbox(targetAgent: AgentId, userId: string, limit = 25): Promise<AgentEvent[]> {
    return this.store.list({ userId, targetAgent, status: "accepted", limit });
  }

  async list(query: EventQuery): Promise<AgentEvent[]> {
    return this.store.list(query);
  }

  async markCompleted(eventId: string, note?: string): Promise<AgentEvent | null> {
    return this.store.patch(eventId, { status: "completed", reason: note, updatedAt: now() });
  }

  /** Expose the policy for UI (Family consent screen). */
  get rules() {
    return CROSS_AGENT_RULES;
  }
}
