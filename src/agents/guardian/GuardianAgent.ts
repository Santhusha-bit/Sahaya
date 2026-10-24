import { BaseAgent, type AgentConfig, type SandboxPlan } from "../base/BaseAgent";
import type { AgentEvent, AgentTask, AgentTool, ToolContext } from "../base/types";
import { guardianPrompt } from "./guardianPrompt";
import { guardianTools } from "./guardianTools";

export class GuardianAgent extends BaseAgent {
  readonly config: AgentConfig = {
    id: "guardian",
    displayName: "Guardian",
    tagline: "Stay safe and get help when you need it.",
    welcome:
      "Hi, I'm Guardian. I watch out for scams and dangerous situations, and I can get you real help fast. Tell me what's going on, or read me a message that felt off.",
    systemPrompt: guardianPrompt,
    suggestedCommands: [
      "Someone called saying my grandson needs bail money",
      "I got a text asking for a verification code",
      "I need help, I've fallen and can't reach my phone easily",
      "Is this caller from my bank really my bank?",
    ],
    theme: {
      accent: "#2563eb",
      accentSoft: "#dbeafe",
      gradient: "linear-gradient(135deg,#1e3a8a,#2563eb)",
      icon: "shield",
    },
  };

  readonly tools: AgentTool[] = guardianTools;

  protected async seed(): Promise<void> {
    await this.memory.save("incidents", {
      summary: "Resolved: suspicious 'package delivery' text last week.",
      severity: "low",
      status: "resolved",
    });
  }

  /** React to validated cross-agent events (Wellness/Care escalations). */
  async handleEvent(event: AgentEvent): Promise<AgentTask | null> {
    if (event.type === "safety.escalation") {
      const summary = String(event.payload.summary ?? "Safety concern from Wellness");
      const severity = String(event.payload.severity ?? "high");
      await this.memory.save(
        "incidents",
        { summary: `From Wellness: ${summary}`, severity, status: "open", source: event.sourceAgent },
        { tags: ["incident", "escalation"] },
      );
      return this.taskService.create({
        title: `Safety escalation: ${summary}`,
        description: `Escalated by ${event.sourceAgent}.`,
        steps: ["Assess", "Contact / verify", "Resolve"],
        status: "in_progress",
        correlationId: event.correlationId,
      });
    }
    if (event.type === "assistance.request") {
      const need = String(event.payload.need ?? "Physical assistance");
      await this.memory.save(
        "assistance",
        { need, urgency: event.payload.urgency ?? "soon", status: "open", source: event.sourceAgent },
        { tags: ["assistance"] },
      );
      return this.taskService.create({
        title: `Coordinate help (from ${event.sourceAgent}): ${need}`,
        steps: ["Request received", "Helper assigned", "Help delivered"],
        status: "in_progress",
        correlationId: event.correlationId,
      });
    }
    return super.handleEvent(event);
  }

  protected async sandboxPlan(message: string, _ctx: ToolContext): Promise<SandboxPlan> {
    const m = message.toLowerCase();
    if (/fall|fell|can'?t get up|emergency|help me|chest|can'?t breathe/.test(m)) {
      return {
        reply: "I hear you. Stay as calm as you can — I'm requesting help right now and I'll stay with you.",
        toolCalls: [{ name: "requestEmergencyAssistance", input: { situation: message, severity: "high" } }],
      };
    }
    if (/code|gift ?card|bank|money|scam|suspicious|arrest|irs|grandson|wire/.test(m)) {
      return {
        reply: "Let me check this message for scam signals before you do anything.",
        toolCalls: [{ name: "analyzeSuspiciousConversation", input: { content: message, channel: "phone" } }],
      };
    }
    if (/verify|who they|really my|is this really/.test(m)) {
      return {
        reply: "Smart to double-check. Let's verify who they really are.",
        toolCalls: [{ name: "initiateTrustedVerification", input: { claimant: message, method: "callback_known_number" } }],
      };
    }
    return {
      reply:
        "I'm here to keep you safe. If something feels off — a strange call, a request for money or codes, or you need help — tell me and I'll act. (Sandbox mode: add an ANTHROPIC_API_KEY for full conversation.)",
    };
  }
}
