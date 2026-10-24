/**
 * Agent-to-agent messaging bridge (Track 5).
 *
 * The TypeScript agents stay authoritative. A thin bridge carries ONE declared
 * cross-agent event (wellness -> guardian "assistance.request") as a typed
 * message. Live mode posts to the Python uAgents service (services/uagents) over
 * local HTTP; sandbox mode runs the exact same exchange over the in-process event
 * bus. Only declared bus events may cross, with the same schema + consent checks.
 * The minimum data crosses (need, urgency, consent ref) — never a conversation.
 *
 * Honesty (global rule 1): without a reachable Python bridge, the capability runs
 * in-process and is labeled "sandbox (in-process bus)", never "Fetch.ai".
 */

import { z } from "zod";
import { fetchaiStatus } from "@/lib/env";
import { id } from "@/lib/id";
import { AgentEventBus } from "@/agents/base/AgentEventBus";
import { AuditLog } from "@/agents/base/audit";
import { DEFAULT_CONSENT, type ConsentSettings } from "@/agents/base/policy";
import { getDataLayer } from "@/agents/base/dataLayer";
import { createAgent } from "@/agents/registry";
import type { DataLayer } from "@/agents/base/types";

export const AssistanceRequestSchema = z.object({
  request_id: z.string().min(1),
  from_agent: z.literal("wellness"),
  to_agent: z.literal("guardian"),
  user_id: z.string().min(1),
  need: z.string().min(1).max(300),
  consent_ref: z.string().min(1).max(80),
  urgency: z.enum(["routine", "soon", "urgent"]),
});
export type AssistanceRequest = z.infer<typeof AssistanceRequestSchema>;

export const AssistanceResponseSchema = z.object({
  request_id: z.string(),
  task_id: z.string(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
});
export type AssistanceResponse = z.infer<typeof AssistanceResponseSchema>;

export interface AssistanceBridge {
  readonly backend: "fetchai" | "sandbox";
  send(req: unknown): Promise<AssistanceResponse>;
}

function requestId(raw: unknown): string {
  return typeof raw === "object" && raw && "request_id" in raw ? String((raw as any).request_id || "unknown") : "unknown";
}

/**
 * In-process realization: validates the typed message, maps it to the declared
 * bus event, runs the bus checks, then has Guardian accept and coordinate help.
 */
export class SandboxBridge implements AssistanceBridge {
  readonly backend = "sandbox" as const;
  constructor(
    private readonly data: DataLayer,
    private readonly consent: ConsentSettings = DEFAULT_CONSENT,
  ) {}

  async send(raw: unknown): Promise<AssistanceResponse> {
    const audit = new AuditLog(this.data.memory, requestId(raw));
    const parsed = AssistanceRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        request_id: requestId(raw),
        task_id: "",
        status: "rejected",
        reason: `invalid_request_schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      };
    }
    const req = parsed.data;
    await new AuditLog(this.data.memory, req.user_id).record({
      actor: "bridge:wellness",
      action: "assistance.request.sent",
      correlationId: req.request_id,
      detail: { need: req.need, urgency: req.urgency },
    });

    // Only the declared event crosses, with the same bus validation + consent.
    const bus = new AgentEventBus(this.data.events, this.consent);
    const pub = await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "assistance.request",
      userId: req.user_id,
      correlationId: req.request_id,
      payload: { need: req.need, urgency: req.urgency, consentRef: req.consent_ref },
    });
    if (!pub.ok) {
      return { request_id: req.request_id, task_id: "", status: "rejected", reason: pub.reason };
    }

    // Guardian accepts and starts helper coordination.
    const guardian = createAgent("guardian", { data: this.data, userId: req.user_id, consent: this.consent });
    await guardian.initialize();
    const task = await guardian.handleEvent(pub.event);
    await bus.markCompleted(pub.event.id, "accepted via bridge");

    const response: AssistanceResponse = {
      request_id: req.request_id,
      task_id: task?.id ?? "",
      status: "accepted",
    };
    await new AuditLog(this.data.memory, req.user_id).record({
      actor: "bridge:guardian",
      action: "assistance.response.sent",
      correlationId: req.request_id,
      detail: { task_id: response.task_id, status: response.status },
    });
    void audit;
    return response;
  }
}

/** Live uAgents bridge: posts the typed message to the Python service. */
export class FetchAIBridge implements AssistanceBridge {
  readonly backend = "fetchai" as const;
  constructor(private readonly url: string) {}

  async send(raw: unknown): Promise<AssistanceResponse> {
    const parsed = AssistanceRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { request_id: requestId(raw), task_id: "", status: "rejected", reason: "invalid_request_schema" };
    }
    const res = await fetch(`${this.url.replace(/\/$/, "")}/assistance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    if (!res.ok) {
      return { request_id: parsed.data.request_id, task_id: "", status: "rejected", reason: `bridge_http_${res.status}` };
    }
    const data = await res.json();
    const out = AssistanceResponseSchema.safeParse(data);
    return out.success
      ? out.data
      : { request_id: parsed.data.request_id, task_id: "", status: "rejected", reason: "invalid_response_schema" };
  }
}

export function createAssistanceBridge(opts?: { data?: DataLayer; consent?: ConsentSettings }): AssistanceBridge {
  if (fetchaiStatus().mode === "live" && process.env.FETCHAI_BRIDGE_URL) {
    return new FetchAIBridge(process.env.FETCHAI_BRIDGE_URL);
  }
  return new SandboxBridge(opts?.data ?? getDataLayer(), opts?.consent ?? DEFAULT_CONSENT);
}

/**
 * Wellness-side orchestration: record consent, send the typed request through the
 * bridge, and turn the response into something to say to the person.
 */
export async function requestAssistance(
  bridge: AssistanceBridge,
  input: { userId: string; need: string; urgency?: AssistanceRequest["urgency"] },
): Promise<{ request: AssistanceRequest; response: AssistanceResponse; userMessage: string }> {
  const request: AssistanceRequest = {
    request_id: id("areq"),
    from_agent: "wellness",
    to_agent: "guardian",
    user_id: input.userId,
    need: input.need,
    consent_ref: id("consent"), // Wellness recorded the person's consent.
    urgency: input.urgency ?? "soon",
  };
  const response = await bridge.send(request);
  const userMessage =
    response.status === "accepted"
      ? "I've asked Guardian to help arrange that, and they've started coordinating a helper for you."
      : "I wasn't able to arrange that help just now, but I'll stay with you and we can try another way.";
  return { request, response, userMessage };
}
