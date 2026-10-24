import { getConsent } from "./consent";
import { getDataLayer } from "./base/dataLayer";
import type { BaseAgent, AgentReply } from "./base/BaseAgent";
import { AGENT_IDS, createAgent } from "./registry";
import type {
  AgentEvent,
  AgentId,
  AgentTask,
  Approval,
  ConversationMessage,
  DataLayer,
  ToolCallRecord,
} from "./base/types";

/**
 * Application-level orchestration over the independent agents. Builds each agent
 * with the shared data layer + the user's consent, drives message turns, and —
 * crucially — delivers validated cross-agent events to their target agents so
 * collaboration actually happens (but only through the authorized bus).
 */
export class AgentService {
  constructor(
    private readonly data: DataLayer,
    private readonly userId: string,
  ) {}

  static async forUser(userId: string): Promise<AgentService> {
    return new AgentService(getDataLayer(), userId);
  }

  get backend() {
    return this.data.backend;
  }

  private async build(agentId: AgentId): Promise<BaseAgent> {
    const consent = await getConsent(this.data, this.userId);
    const agent = createAgent(agentId, { data: this.data, userId: this.userId, consent });
    await agent.initialize();
    return agent;
  }

  async initializeAll(): Promise<void> {
    for (const id of AGENT_IDS) await this.build(id);
  }

  /** Deliver any accepted-but-undelivered cross-agent events to their targets. */
  async deliverEvents(): Promise<AgentEvent[]> {
    const delivered: AgentEvent[] = [];
    for (const id of AGENT_IDS) {
      const agent = await this.build(id);
      const inbox = await agent.bus.inbox(id, this.userId, 25);
      for (const evt of inbox) {
        await agent.handleEvent(evt);
        const done = await agent.bus.markCompleted(evt.id, "handled");
        if (done) delivered.push(done);
      }
    }
    return delivered;
  }

  async sendMessage(
    agentId: AgentId,
    text: string,
    via: "voice" | "text" = "text",
  ): Promise<{ reply: AgentReply; deliveredEvents: AgentEvent[] }> {
    const agent = await this.build(agentId);
    const reply = via === "voice" ? await agent.processVoiceInput(text) : await agent.processMessage(text);
    const deliveredEvents = await this.deliverEvents();
    return { reply, deliveredEvents };
  }

  /** Like sendMessage, but streams the reply text via onToken as it is generated. */
  async streamMessage(
    agentId: AgentId,
    text: string,
    via: "voice" | "text",
    onToken: (delta: string) => void,
  ): Promise<{ reply: AgentReply; deliveredEvents: AgentEvent[] }> {
    const agent = await this.build(agentId);
    const reply = await agent.processMessage(text, { via, onText: onToken });
    const deliveredEvents = await this.deliverEvents();
    return { reply, deliveredEvents };
  }

  /** Approve or reject a pending approval; on approval, execute the deferred tool. */
  async decideApproval(
    agentId: AgentId,
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<{ approval: Approval | null; record?: ToolCallRecord }> {
    const agent = await this.build(agentId);
    const approval = await agent.approvalService.get(approvalId);
    if (!approval || approval.status !== "pending") return { approval: approval ?? null };

    if (decision === "reject") {
      const updated = await this.data.approvals.patch(approvalId, { status: "rejected", decidedAt: Date.now() });
      return { approval: updated };
    }

    const { record } = await agent.executeTool(approval.toolName, approval.input, {
      approved: true,
      correlationId: approval.correlationId,
    });
    const updated = await this.data.approvals.patch(approvalId, { status: "approved", decidedAt: Date.now() });
    await this.deliverEvents();
    return { approval: updated, record };
  }

  async agentState(agentId: AgentId): Promise<{
    tasks: AgentTask[];
    approvals: Approval[];
    history: ConversationMessage[];
    inbox: AgentEvent[];
  }> {
    const agent = await this.build(agentId);
    const [tasks, approvals, history, inbox] = await Promise.all([
      agent.taskService.list(),
      agent.approvalService.list("pending"),
      this.data.conversations.history({ userId: this.userId, agentId, limit: 50 }),
      agent.bus.list({ userId: this.userId, targetAgent: agentId, limit: 25 }),
    ]);
    return { tasks, approvals, history, inbox };
  }

  /** Aggregate view for the caregiver/family dashboard (respects consent). */
  async familyFeed(): Promise<{
    perAgent: Record<AgentId, { tasks: AgentTask[]; approvals: Approval[] }>;
    events: AgentEvent[];
  }> {
    await this.initializeAll();
    const consent = await getConsent(this.data, this.userId);
    const perAgent = {} as Record<AgentId, { tasks: AgentTask[]; approvals: Approval[] }>;
    for (const id of AGENT_IDS) {
      const allowed = consent[`caregiver${id.charAt(0).toUpperCase()}${id.slice(1)}`];
      if (!allowed) {
        perAgent[id] = { tasks: [], approvals: [] };
        continue;
      }
      perAgent[id] = {
        tasks: await this.data.tasks.list({ userId: this.userId, agentId: id }),
        approvals: await this.data.approvals.list({ userId: this.userId, agentId: id }),
      };
    }
    const events = await this.data.events.list({ userId: this.userId, limit: 40 });
    return { perAgent, events };
  }

  async allEvents(limit = 50): Promise<AgentEvent[]> {
    return this.data.events.list({ userId: this.userId, limit });
  }
}
