/**
 * Agent-to-agent messaging over Fetch.ai uAgents.
 *
 * The TypeScript agents stay authoritative. Wellness, Care and Finance each have
 * their OWN Python uAgent (services/uagents/requester_agent.py), and Guardian has
 * one too (guardian_agent.py); each runs as a separate process with its own
 * identity. A request travels:
 *
 *   TS Wellness --POST /assistance--> wellness uAgent --signed envelope--> guardian uAgent
 *     --POST {GUARDIAN_AGENT_URL}/assistance--> TS Guardian (acceptAssistanceAtGuardian)
 *   and the task id + status ride the same path back.
 *
 * Sandbox mode (no uAgent URL configured) runs the identical exchange in-process:
 * same request schema, same Guardian intake, same bus policy + consent checks.
 * Only the minimum data crosses (need, urgency, consent ref), never a conversation.
 *
 * Honesty (global rule 1): without a reachable uAgent, the capability is labeled
 * "sandbox (in-process bus)", never "Fetch.ai". A live bridge that cannot be
 * reached is reported as a rejection, not silently swapped for the sandbox.
 */

import { z } from "zod";
import { id } from "@/lib/id";
import { AgentEventBus } from "@/agents/base/AgentEventBus";
import { AuditLog } from "@/agents/base/audit";
import { DEFAULT_CONSENT, type ConsentSettings } from "@/agents/base/policy";
import { getDataLayer } from "@/agents/base/dataLayer";
import { createAgent } from "@/agents/registry";
import type { DataLayer } from "@/agents/base/types";

export const REQUESTER_AGENTS = ["wellness", "care", "finance"] as const;
export type RequesterAgent = (typeof REQUESTER_AGENTS)[number];

/** Wire contract; mirrors services/uagents/messages.py. */
export const BridgedAssistanceRequestSchema = z.object({
  request_id: z.string().min(1),
  from_agent: z.enum(REQUESTER_AGENTS),
  to_agent: z.literal("guardian"),
  user_id: z.string().min(1),
  need: z.string().min(1).max(300),
  consent_ref: z.string().min(1).max(80),
  urgency: z.enum(["routine", "soon", "urgent"]),
});
export type BridgedAssistanceRequest = z.infer<typeof BridgedAssistanceRequestSchema>;

export const AssistanceRequestSchema = BridgedAssistanceRequestSchema.extend({ from_agent: z.literal("wellness") });
export type AssistanceRequest = z.infer<typeof AssistanceRequestSchema>;

export const FinanceAssistanceRequestSchema = BridgedAssistanceRequestSchema.extend({ from_agent: z.literal("finance") });
export type FinanceAssistanceRequest = z.infer<typeof FinanceAssistanceRequestSchema>;

const schemaFor: Record<RequesterAgent, z.ZodType<BridgedAssistanceRequest>> = {
  wellness: AssistanceRequestSchema,
  care: BridgedAssistanceRequestSchema.extend({ from_agent: z.literal("care") }),
  finance: FinanceAssistanceRequestSchema,
};

export const AssistanceResponseSchema = z.object({
  request_id: z.string(),
  task_id: z.string(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
  /** Guardian's task state, e.g. "in_progress". */
  task_status: z.string().optional(),
  /** uAgent address of the Guardian that handled it (live mode only). */
  coordinator: z.string().optional(),
});
export type AssistanceResponse = z.infer<typeof AssistanceResponseSchema>;

export interface AssistanceBridge {
  readonly backend: "fetchai" | "sandbox";
  send(req: unknown): Promise<AssistanceResponse>;
}
export type FinanceAssistanceBridge = AssistanceBridge;

function requestId(raw: unknown): string {
  return typeof raw === "object" && raw && "request_id" in raw ? String((raw as any).request_id || "unknown") : "unknown";
}

function rejected(request_id: string, reason: string): AssistanceResponse {
  return { request_id, task_id: "", status: "rejected", reason };
}

function schemaIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
}

/**
 * Guardian's intake for a bridged assistance request. Used by the in-process
 * sandbox AND by the HTTP endpoint the Guardian uAgent calls in live mode, so
 * both paths get the same schema, bus policy, consent and audit checks.
 */
export async function acceptAssistanceAtGuardian(
  data: DataLayer,
  raw: unknown,
  consent: ConsentSettings = DEFAULT_CONSENT,
): Promise<AssistanceResponse> {
  const parsed = BridgedAssistanceRequestSchema.safeParse(raw);
  if (!parsed.success) return rejected(requestId(raw), `invalid_request_schema: ${schemaIssues(parsed.error)}`);
  const req = parsed.data;
  const audit = new AuditLog(data.memory, req.user_id);
  await audit.record({
    actor: "guardian",
    action: "assistance.request.received",
    correlationId: req.request_id,
    detail: { from: req.from_agent, need: req.need, urgency: req.urgency },
  });

  // Only a declared event crosses, with the same bus validation + consent.
  const bus = new AgentEventBus(data.events, consent);
  const pub = await bus.publish({
    sourceAgent: req.from_agent,
    targetAgent: "guardian",
    type: "assistance.request",
    userId: req.user_id,
    correlationId: req.request_id,
    payload: { need: req.need, urgency: req.urgency, consentRef: req.consent_ref },
  });
  if (!pub.ok) return rejected(req.request_id, pub.reason ?? "blocked_by_policy");

  // Guardian accepts and starts helper coordination.
  const guardian = createAgent("guardian", { data, userId: req.user_id, consent });
  await guardian.initialize();
  const task = await guardian.handleEvent(pub.event);
  await bus.markCompleted(pub.event.id, `accepted via bridge from ${req.from_agent}`);

  const response: AssistanceResponse = {
    request_id: req.request_id,
    task_id: task?.id ?? "",
    status: "accepted",
    task_status: task?.status,
  };
  await audit.record({
    actor: "guardian",
    action: "assistance.response.sent",
    correlationId: req.request_id,
    detail: { to: req.from_agent, task_id: response.task_id, status: response.status },
  });
  return response;
}

/** In-process realization: same contract and Guardian intake, no network. */
export class SandboxBridge implements AssistanceBridge {
  readonly backend = "sandbox" as const;
  constructor(
    private readonly data: DataLayer,
    private readonly consent: ConsentSettings = DEFAULT_CONSENT,
    private readonly from: RequesterAgent = "wellness",
  ) {}

  async send(raw: unknown): Promise<AssistanceResponse> {
    const parsed = schemaFor[this.from].safeParse(raw);
    if (!parsed.success) return rejected(requestId(raw), `invalid_request_schema: ${schemaIssues(parsed.error)}`);
    await new AuditLog(this.data.memory, parsed.data.user_id).record({
      actor: `bridge:${this.from}`,
      action: "assistance.request.sent",
      correlationId: parsed.data.request_id,
      detail: { need: parsed.data.need, urgency: parsed.data.urgency },
    });
    return acceptAssistanceAtGuardian(this.data, parsed.data, this.consent);
  }
}

/** Live: posts the typed request to this agent's own uAgent, which messages Guardian's uAgent. */
export class FetchAIBridge implements AssistanceBridge {
  readonly backend = "fetchai" as const;
  constructor(
    private readonly url: string,
    private readonly from: RequesterAgent = "wellness",
  ) {}

  async send(raw: unknown): Promise<AssistanceResponse> {
    const parsed = schemaFor[this.from].safeParse(raw);
    if (!parsed.success) return rejected(requestId(raw), "invalid_request_schema");
    let res: Response;
    try {
      res = await fetch(`${this.url.replace(/\/$/, "")}/assistance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return rejected(parsed.data.request_id, `fetchai_bridge_unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) return rejected(parsed.data.request_id, `bridge_http_${res.status}`);
    const out = AssistanceResponseSchema.safeParse(await res.json());
    return out.success ? out.data : rejected(parsed.data.request_id, "invalid_response_schema");
  }
}

/**
 * Where an agent's uAgent listens: FETCHAI_<AGENT>_URL, or for Wellness the
 * original FETCHAI_BRIDGE_URL. Each requester has its own uAgent and URL.
 */
export function bridgeUrlFor(agent: RequesterAgent): string | undefined {
  const own = process.env[`FETCHAI_${agent.toUpperCase()}_URL`]?.trim();
  if (own) return own;
  if (agent === "wellness") return process.env.FETCHAI_BRIDGE_URL?.trim() || undefined;
  return undefined;
}

export function createAssistanceBridge(opts?: {
  data?: DataLayer;
  consent?: ConsentSettings;
  from?: RequesterAgent;
}): AssistanceBridge {
  const from = opts?.from ?? "wellness";
  const url = bridgeUrlFor(from);
  if (url) return new FetchAIBridge(url, from);
  return new SandboxBridge(opts?.data ?? getDataLayer(), opts?.consent ?? DEFAULT_CONSENT, from);
}

/** Finance-side aliases (kept for existing callers). */
export class FinanceSandboxBridge extends SandboxBridge {
  constructor(data: DataLayer, consent: ConsentSettings = DEFAULT_CONSENT) {
    super(data, consent, "finance");
  }
}
export class FinanceFetchAIBridge extends FetchAIBridge {
  constructor(url: string) {
    super(url, "finance");
  }
}
export function createFinanceAssistanceBridge(opts?: { data?: DataLayer; consent?: ConsentSettings }): AssistanceBridge {
  return createAssistanceBridge({ ...opts, from: "finance" });
}

function describeAccepted(res: AssistanceResponse): string {
  return `task ${res.task_id}${res.task_status ? `, ${res.task_status.replace(/_/g, " ")}` : ""}`;
}

/**
 * Finance-side orchestration: when Finance finds something a person cannot
 * resolve alone, it asks Guardian to coordinate a human helper. Consent is
 * recorded by the caller (the Finance tool) before this is invoked.
 */
export async function requestFinancialAssistance(
  bridge: AssistanceBridge,
  input: { userId: string; need: string; consentRef: string; urgency?: FinanceAssistanceRequest["urgency"] },
): Promise<{ request: FinanceAssistanceRequest; response: AssistanceResponse; userMessage: string }> {
  const request: FinanceAssistanceRequest = {
    request_id: id("fareq"),
    from_agent: "finance",
    to_agent: "guardian",
    user_id: input.userId,
    need: input.need,
    consent_ref: input.consentRef,
    urgency: input.urgency ?? "soon",
  };
  const response = await bridge.send(request);
  const userMessage =
    response.status === "accepted"
      ? `I've asked Guardian to arrange a person to help you with this, and they've started coordinating it (${describeAccepted(response)}).`
      : "I wasn't able to arrange that help just now, but we can try another way together.";
  return { request, response, userMessage };
}

/**
 * Care-side orchestration: Care asks Guardian to arrange physical human help
 * (e.g. someone to collect a medication). Same bridge, Care's own uAgent.
 */
export async function requestCareAssistance(input: {
  data: DataLayer;
  userId: string;
  need: string;
  urgency?: AssistanceRequest["urgency"];
  consent?: ConsentSettings;
  correlationId?: string;
}): Promise<{ ok: boolean; backend: "fetchai" | "sandbox"; taskId: string; userMessage: string; reason?: string }> {
  const bridge = createAssistanceBridge({ data: input.data, consent: input.consent, from: "care" });
  const response = await bridge.send({
    request_id: input.correlationId ?? id("careassist"),
    from_agent: "care",
    to_agent: "guardian",
    user_id: input.userId,
    need: input.need.slice(0, 300),
    consent_ref: id("consent"),
    urgency: input.urgency ?? "soon",
  });
  const ok = response.status === "accepted";
  return {
    ok,
    backend: bridge.backend,
    taskId: response.task_id,
    userMessage: ok
      ? `I've asked Guardian to arrange a helper for that, and they've started coordinating (${describeAccepted(response)}).`
      : "I couldn't arrange that help just now, but we can try another way.",
    reason: response.reason,
  };
}

/**
 * Wellness-side orchestration: send the typed request through the bridge and
 * turn Guardian's response into something to say to the person. The caller has
 * already obtained the person's permission and recorded it as `consentRef`.
 */
export async function requestAssistance(
  bridge: AssistanceBridge,
  input: { userId: string; need: string; urgency?: AssistanceRequest["urgency"]; consentRef?: string; requestId?: string },
): Promise<{ request: AssistanceRequest; response: AssistanceResponse; userMessage: string }> {
  const request: AssistanceRequest = {
    request_id: input.requestId ?? id("areq"),
    from_agent: "wellness",
    to_agent: "guardian",
    user_id: input.userId,
    need: input.need,
    consent_ref: input.consentRef ?? id("consent"),
    urgency: input.urgency ?? "soon",
  };
  const response = await bridge.send(request);
  const userMessage =
    response.status === "accepted"
      ? `Guardian accepted your request and has started arranging someone to help you (${describeAccepted(response)}). I'll let you know as soon as a helper is assigned.`
      : "I wasn't able to arrange that help just now, but I'll stay with you and we can try another way.";
  return { request, response, userMessage };
}
