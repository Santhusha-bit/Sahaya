import { correlationId as newCorrelationId, id, now } from "@/lib/id";
import { llmAvailable, llmTurn, llmTurnStream, type LlmMessage, type LlmToolSpec } from "@/lib/llm";
import { AgentEventBus } from "./AgentEventBus";
import { AuditLog } from "./audit";
import type { ConsentSettings } from "./policy";
import { DEFAULT_CONSENT } from "./policy";
import { ScopedMemoryImpl } from "./ScopedMemory";
import { ApprovalService, TaskService } from "./services";
import type {
  AgentEvent,
  AgentId,
  AgentTask,
  AgentTool,
  ConversationMessage,
  DataLayer,
  MemoryRecord,
  TaskStatus,
  ToolCallRecord,
  ToolContext,
  ToolResult,
} from "./types";
import { zodToJsonSchema } from "./zodToJsonSchema";

export interface AgentTheme {
  accent: string;
  accentSoft: string;
  gradient: string;
  icon: string;
}

export interface AgentConfig {
  id: AgentId;
  displayName: string;
  tagline: string;
  welcome: string;
  systemPrompt: string;
  suggestedCommands: string[];
  theme: AgentTheme;
}

export interface AgentDeps {
  data: DataLayer;
  userId: string;
  consent?: ConsentSettings;
}

export interface SandboxPlan {
  reply: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

export interface AgentReply {
  agentId: AgentId;
  text: string;
  correlationId: string;
  toolCalls: ToolCallRecord[];
  approvalsRequested: string[];
}

const MAX_TOOL_LOOPS = 6;

/**
 * BaseAgent is the reusable runtime every agent extends. Each concrete agent
 * supplies its own config (prompt/persona), tool registry, and sandbox planner;
 * the base class provides the shared machinery and the full method surface from
 * prompt §2 — all scoped so one agent can never touch another's data or tools.
 */
export abstract class BaseAgent {
  abstract readonly config: AgentConfig;
  abstract readonly tools: AgentTool[];
  /** Deterministic planner used when no Claude key is configured. */
  protected abstract sandboxPlan(message: string, ctx: ToolContext): Promise<SandboxPlan>;
  /** Optional one-time demo seeding. */
  protected async seed(): Promise<void> {}

  /**
   * Optional hot-path optimization. If it returns tool calls, the runtime runs
   * them deterministically FIRST, then makes a SINGLE streaming model call to
   * phrase the reply — avoiding slow model-driven tool round trips. Return null
   * to use the normal LLM tool loop. (Only used on the live-LLM path.)
   */
  protected fastPath(_message: string): { name: string; input: Record<string, unknown> }[] | null {
    return null;
  }

  readonly userId: string;
  private readonly data: DataLayer;
  private readonly consent: ConsentSettings;
  private toolMap: Map<string, AgentTool> | null = null;

  // Services are created lazily: `config` (a subclass class-field) isn't set
  // until after super() returns, so we can't read `this.id` in the constructor.
  private _memory?: ScopedMemoryImpl;
  private _bus?: AgentEventBus;
  private _tasks?: TaskService;
  private _approvals?: ApprovalService;
  private _audit?: AuditLog;

  constructor(deps: AgentDeps) {
    this.data = deps.data;
    this.userId = deps.userId;
    this.consent = deps.consent ?? DEFAULT_CONSENT;
  }

  get id(): AgentId {
    return this.config.id;
  }

  // Each service is bound to THIS agent id — no way to address another agent.
  get memory(): ScopedMemoryImpl {
    return (this._memory ??= new ScopedMemoryImpl(this.data.memory, this.id, this.userId));
  }
  get bus(): AgentEventBus {
    return (this._bus ??= new AgentEventBus(this.data.events, this.consent));
  }
  get taskService(): TaskService {
    return (this._tasks ??= new TaskService(this.data.tasks, this.id, this.userId));
  }
  get approvalService(): ApprovalService {
    return (this._approvals ??= new ApprovalService(this.data.approvals, this.id, this.userId));
  }
  get audit(): AuditLog {
    return (this._audit ??= new AuditLog(this.data.memory, this.userId));
  }

  private getToolMap(): Map<string, AgentTool> {
    if (!this.toolMap) this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
    return this.toolMap;
  }

  /** prompt §2: initialize() — seed demo state once, idempotently. */
  async initialize(): Promise<void> {
    const marker = await this.memory.list("_init", { limit: 1 });
    if (marker.length) return;
    await this.memory.save("_init", { seededAt: now() });
    await this.seed();
  }

  /** prompt §2: retrieveMemory() */
  async retrieveMemory(collection: string, opts?: { tag?: string; limit?: number }): Promise<MemoryRecord[]> {
    return this.memory.list(collection, opts);
  }

  /** prompt §2: planTask() */
  async planTask(input: {
    title: string;
    description?: string;
    steps?: string[];
    correlationId?: string;
    status?: TaskStatus;
  }): Promise<AgentTask> {
    return this.taskService.create(input);
  }

  /** prompt §2: scheduleTask() — persists intent + a scheduled task row. */
  async scheduleTask(input: {
    title: string;
    runAt: number;
    description?: string;
    steps?: string[];
  }): Promise<AgentTask> {
    const task = await this.taskService.create({
      title: input.title,
      description: input.description,
      steps: input.steps,
      status: "planning",
    });
    await this.memory.save(
      "scheduled",
      { taskId: task.id, title: input.title, runAt: input.runAt },
      { tags: ["schedule"] },
    );
    return task;
  }

  /** prompt §2: getTaskStatus() */
  async getTaskStatus(taskId: string): Promise<AgentTask | null> {
    return this.taskService.get(taskId);
  }

  /** prompt §2: requestApproval() */
  async requestApproval(input: {
    toolName: string;
    toolInput: unknown;
    title: string;
    description: string;
    correlationId?: string;
  }) {
    return this.approvalService.request(input);
  }

  buildContext(correlationId: string, log: (line: string) => void): ToolContext {
    return {
      agentId: this.id,
      userId: this.userId,
      correlationId,
      memory: this.memory,
      bus: this.bus,
      tasks: this.taskService,
      approvals: this.approvalService,
      audit: this.audit,
      log,
    };
  }

  /** prompt §2: executeTool() — validation, approval gate, execution, errors. */
  async executeTool(
    name: string,
    input: unknown,
    opts: { approved?: boolean; correlationId?: string; log?: (l: string) => void } = {},
  ): Promise<{ record: ToolCallRecord; result: ToolResult }> {
    const correlationId = opts.correlationId ?? newCorrelationId();
    const log = opts.log ?? (() => {});
    const startedAt = now();
    const tool = this.getToolMap().get(name);

    const baseRecord = (): ToolCallRecord => ({
      id: id("call"),
      toolName: name,
      input,
      status: "error",
      summary: "",
      startedAt,
      finishedAt: now(),
    });

    if (!tool) {
      const result: ToolResult = { ok: false, summary: `Unknown tool "${name}".`, error: "unknown_tool" };
      return { record: { ...baseRecord(), summary: result.summary, error: result.error }, result };
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      const result: ToolResult = { ok: false, summary: `Invalid input for ${name}.`, error: msg };
      return { record: { ...baseRecord(), summary: result.summary, error: msg }, result };
    }
    const value = parsed.data;

    const requires =
      typeof tool.requiresApproval === "function" ? tool.requiresApproval(value) : !!tool.requiresApproval;

    if (requires && !opts.approved) {
      const { title, description } = tool.approvalSummary?.(value) ?? {
        title: `Approve ${tool.name}`,
        description: tool.description,
      };
      const approval = await this.approvalService.request({
        toolName: name,
        toolInput: value,
        title,
        description,
        correlationId,
      });
      log(`requested approval ${approval.id} for ${name}`);
      const result: ToolResult = { ok: false, summary: `Awaiting your approval: ${title}`, approvalId: approval.id };
      return {
        record: {
          id: id("call"),
          toolName: name,
          input: value,
          status: "awaiting_approval",
          summary: result.summary,
          approvalId: approval.id,
          startedAt,
          finishedAt: now(),
        },
        result,
      };
    }

    try {
      const ctx = this.buildContext(correlationId, log);
      const result = await tool.execute(value, ctx);
      return {
        record: {
          id: id("call"),
          toolName: name,
          input: value,
          status: result.ok ? "success" : "error",
          summary: result.summary,
          output: result.data,
          error: result.error,
          approvalId: result.approvalId,
          startedAt,
          finishedAt: now(),
        },
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`tool ${name} threw: ${message}`);
      const result: ToolResult = { ok: false, summary: `${name} failed: ${message}`, error: message };
      return { record: { ...baseRecord(), summary: result.summary, error: message }, result };
    }
  }

  /** prompt §2: handleEvent() — default reaction; agents override to act. */
  async handleEvent(event: AgentEvent): Promise<AgentTask | null> {
    await this.memory.save("inbox", { event }, { tags: ["event", event.type] });
    return this.taskService.create({
      title: `Incoming: ${event.type} from ${event.sourceAgent}`,
      description: JSON.stringify(event.payload),
      status: "in_progress",
      correlationId: event.correlationId,
    });
  }

  /** prompt §2: processVoiceInput() — transcript handed off to processMessage. */
  async processVoiceInput(transcript: string): Promise<AgentReply> {
    return this.processMessage(transcript, { via: "voice" });
  }

  /** prompt §2: processMessage() — the core turn, LLM loop or sandbox planner. */
  async processMessage(
    text: string,
    meta?: { via?: "voice" | "text"; onText?: (delta: string) => void },
  ): Promise<AgentReply> {
    const correlationId = newCorrelationId();
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);

    await this.data.conversations.append({
      id: id("msg"),
      agentId: this.id,
      userId: this.userId,
      role: "user",
      content: text,
      createdAt: now(),
    });

    const toolCalls: ToolCallRecord[] = [];
    const approvalsRequested: string[] = [];
    let finalText = "";

    if (llmAvailable()) {
      finalText = await this.runLlmLoop(text, correlationId, toolCalls, approvalsRequested, log, meta?.onText);
    } else {
      finalText = await this.runSandbox(text, correlationId, toolCalls, approvalsRequested, log, meta?.onText);
    }

    await this.data.conversations.append({
      id: id("msg"),
      agentId: this.id,
      userId: this.userId,
      role: "assistant",
      content: finalText,
      createdAt: now(),
      toolCalls,
    });

    void meta;
    return { agentId: this.id, text: finalText, correlationId, toolCalls, approvalsRequested };
  }

  private toolSpecs(): LlmToolSpec[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }));
  }

  private async recentHistory(): Promise<LlmMessage[]> {
    const history = await this.data.conversations.history({
      userId: this.userId,
      agentId: this.id,
      limit: 12,
    });
    return history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  }

  private async runLlmLoop(
    text: string,
    correlationId: string,
    toolCalls: ToolCallRecord[],
    approvalsRequested: string[],
    log: (l: string) => void,
    onText?: (delta: string) => void,
  ): Promise<string> {
    // Hot path: run the deterministic tool plan up front, then one model call.
    const fast = this.fastPath(text);
    if (fast && fast.length) {
      return this.runFastPath(text, fast, correlationId, toolCalls, approvalsRequested, log, onText);
    }

    const specs = this.toolSpecs();
    const messages: LlmMessage[] = [...(await this.recentHistory()), { role: "user", content: text }];
    let finalText = "";

    for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
      const turn = onText
        ? await llmTurnStream({ system: this.config.systemPrompt, messages, tools: specs, onText })
        : await llmTurn({ system: this.config.systemPrompt, messages, tools: specs });
      if (turn.text) finalText = turn.text;
      if (!turn.toolUses.length) break;

      messages.push({ role: "assistant", content: turn.assistantContent });
      const results = [];
      for (const use of turn.toolUses) {
        const { record, result } = await this.executeTool(use.name, use.input, { correlationId, log });
        toolCalls.push(record);
        if (record.approvalId) approvalsRequested.push(record.approvalId);
        results.push({
          type: "tool_result" as const,
          tool_use_id: use.id,
          content: JSON.stringify({ ok: result.ok, summary: result.summary, data: result.data, error: result.error }),
          is_error: !result.ok && !result.approvalId,
        });
      }
      messages.push({ role: "user", content: results });
    }

    return finalText || "Done.";
  }

  /** Run a deterministic tool plan, then a single streaming model call to phrase. */
  private async runFastPath(
    text: string,
    plan: { name: string; input: Record<string, unknown> }[],
    correlationId: string,
    toolCalls: ToolCallRecord[],
    approvalsRequested: string[],
    log: (l: string) => void,
    onText?: (delta: string) => void,
  ): Promise<string> {
    const summaries: string[] = [];
    for (const call of plan) {
      const { record, result } = await this.executeTool(call.name, call.input, { correlationId, log });
      toolCalls.push(record);
      if (record.approvalId) approvalsRequested.push(record.approvalId);
      summaries.push(result.summary);
    }
    const findings = summaries.join(" | ");
    const messages: LlmMessage[] = [
      {
        role: "user",
        content: `${text}\n\n(The system has already run its safety checks on this message. Findings: ${findings}\n\nReply to me directly now in 2-4 warm, plain-language sentences based on those findings. Do not call any tools.)`,
      },
    ];
    // Single turn, no tools -> no further model round trips.
    const turn = onText
      ? await llmTurnStream({ system: this.config.systemPrompt, messages, tools: [], onText })
      : await llmTurn({ system: this.config.systemPrompt, messages, tools: [] });
    return turn.text || findings || "Done.";
  }

  private async runSandbox(
    text: string,
    correlationId: string,
    toolCalls: ToolCallRecord[],
    approvalsRequested: string[],
    log: (l: string) => void,
    onText?: (delta: string) => void,
  ): Promise<string> {
    const ctx = this.buildContext(correlationId, log);
    const plan = await this.sandboxPlan(text, ctx);
    const summaries: string[] = [];
    for (const call of plan.toolCalls ?? []) {
      const { record, result } = await this.executeTool(call.name, call.input, { correlationId, log });
      toolCalls.push(record);
      if (record.approvalId) approvalsRequested.push(record.approvalId);
      summaries.push(`• ${result.summary}`);
    }
    const finalText = summaries.length ? `${plan.reply}\n\n${summaries.join("\n")}` : plan.reply;
    // Sandbox mode is instant; emit the whole reply once so streaming clients
    // still receive it through the same channel.
    onText?.(finalText);
    return finalText;
  }
}

export type { ConversationMessage };
