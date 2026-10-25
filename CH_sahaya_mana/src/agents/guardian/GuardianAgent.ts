import { BaseAgent, type AgentDefinition, type AgentDeps } from "../base/BaseAgent";
import type { AgentContext, AgentEvent } from "../base/types";
import { DEFAULT_POLICY } from "../base/policy";
import {
  EVENT_TYPES,
  physicalAssistancePayload,
  safetyConcernPayload,
  suspiciousChargePayload,
} from "../contracts";
import { GUARDIAN_PROMPT } from "./guardianPrompt";
import { GUARDIAN_NAMESPACES, guardianTools } from "./guardianTools";

export const guardianDefinition: AgentDefinition = {
  id: "guardian",
  displayName: "Guardian",
  tagline: "Stay safe and get help when you need it.",
  welcome: "Hi, I'm Guardian. If something feels off — a strange call, a text, or you need a hand — tell me and we'll sort it out together.",
  systemPrompt: GUARDIAN_PROMPT,
  effort: "medium",
  memoryNamespaces: GUARDIAN_NAMESPACES,
  tools: guardianTools,
  policy: { ...DEFAULT_POLICY, approvalTtlMs: 2 * 60 * 60 * 1000 },
  events: {
    outbound: [],
    inbound: [
      {
        type: EVENT_TYPES.safetyConcern,
        from: ["wellness", "care"],
        description: "Wellness or Care asks Guardian to escalate an urgent safety concern",
        payload: safetyConcernPayload,
      },
      {
        type: EVENT_TYPES.physicalAssistance,
        from: ["care"],
        description: "Care asks Guardian to coordinate in-person help",
        payload: physicalAssistancePayload,
      },
      {
        type: EVENT_TYPES.suspiciousCharge,
        from: ["finance"],
        description: "Finance flags a charge that may be fraud",
        payload: suspiciousChargePayload,
      },
    ],
  },
  workflows: [
    {
      id: "scam_check",
      title: "Check a suspicious contact",
      description: "Analyze, record, and verify through a trusted channel",
      steps: [
        { description: "Analyze the conversation for scam indicators", toolName: "analyzeSuspiciousConversation" },
        { description: "Record the incident", toolName: "createSecurityIncident" },
        { description: "Verify through a trusted channel", toolName: "initiateTrustedVerification" },
      ],
    },
    {
      id: "arrange_help",
      title: "Arrange in-person help",
      description: "Open an assistance request, schedule a helper, and track it to completion",
      steps: [
        { description: "Open assistance request", toolName: "createHumanAssistanceRequest" },
        { description: "Schedule a trusted helper", toolName: "scheduleHelper" },
        { description: "Track the helper's response", toolName: "trackAssistanceResponse" },
      ],
    },
    {
      id: "escalate_safety",
      title: "Escalate a safety concern",
      description: "Record the incident and alert trusted contacts",
      steps: [
        { description: "Record the incident", toolName: "createSecurityIncident" },
        { description: "Alert a trusted contact", toolName: "notifyTrustedContact" },
      ],
    },
  ],
  suggestedCommands: [
    "Someone called saying they're from Medicare",
    "I got a text about a package I didn't order",
    "I need someone to help me today",
    "Let my daughter know I'm okay",
  ],
  jobKinds: ["assistance_followup"],
};

export class GuardianAgent extends BaseAgent {
  constructor(deps: AgentDeps) {
    super(guardianDefinition, deps);
  }

  /**
   * Minimal inbound handling for the routes Care uses (physical assistance, safety escalation):
   * record the validated payload in Guardian's own memory and plan Guardian's existing workflow.
   * Idempotent per originating action (correlationId). Telephony is unavailable, so the planned
   * steps stay pending for a human — nothing is claimed to have been sent. Other event types keep
   * the default (rejected) behavior until their handlers land.
   */
  protected override async onEvent(event: AgentEvent, ctx: AgentContext): Promise<{ taskId?: string } | void> {
    const assistance = event.type === EVENT_TYPES.physicalAssistance;
    const safety = event.type === EVENT_TYPES.safetyConcern;
    if (!assistance && !safety) return super.onEvent(event, ctx);
    const namespace = assistance ? "guardian.assistance" : "guardian.incidents";
    const key = `${event.type}:${event.correlationId}`;
    const seen = await this.store.getMemory(event.userId, namespace, key);
    if (seen) return { taskId: (seen.value as { taskId: string }).taskId };
    const task = await this.planTask(ctx, assistance ? "arrange_help" : "escalate_safety", "event");
    const now = this.deps.now();
    await this.store.putMemory({
      id: `mem_${event.id}`,
      userId: event.userId,
      namespace,
      key,
      value: { taskId: task.id, eventId: event.id, from: event.sourceAgent, payload: event.payload, receivedAt: now, status: "open" },
      text: assistance ? `Assistance request from ${event.sourceAgent}` : `Safety concern from ${event.sourceAgent}`,
      createdAt: now,
      updatedAt: now,
    });
    return { taskId: task.id };
  }
}
