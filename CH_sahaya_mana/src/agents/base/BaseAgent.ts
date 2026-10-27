import type Anthropic from "@anthropic-ai/sdk";
import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { newId } from "@/lib/ids";
import type { AgentStore, ScopedAgentStore } from "./AgentStore";
import type { AgentEventContracts } from "./AgentEventBus";
import { AgentError, toErrorMessage } from "./errors";
import type { Effort, LLMClient, LLMResponse } from "./llm";
import { assertCanApprove, assertCanConverse, type AgentPolicy } from "./policy";
import { ToolRegistry, type AnyTool, type ToolContext, type ToolExecutionResult } from "./ToolRegistry";
import type {
  AgentContext,
  AgentEvent,
  AgentId,
  AgentTask,
  ApprovalRequest,
  ConversationMessage,
  MemoryRecord,
  MessageParam,
  ScheduledJob,
  TaskStep,
} from "./types";

export interface WorkflowTemplate {
  id: string;
  title: string;
  description: string;
  steps: Array<{ description: string; toolName?: string }>;
}

/** Static, independently-configured identity of one agent. */
export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  tagline: string;
  welcome: string;
  systemPrompt: string;
  effort: Effort;
  memoryNamespaces: string[];
  tools: AnyTool[];
  events: AgentEventContracts;
  policy: AgentPolicy;
  workflows: WorkflowTemplate[];
  suggestedCommands: string[];
  /** Scheduled job kinds this agent knows how to run. */
  jobKinds: string[];
}

/** Narrow capabilities the runtime hands each agent. No agent ever receives the root store. */
export interface AgentDeps {
  store: ScopedAgentStore;
  permissions: Pick<AgentStore, "getCaregiverPermission">;
  /** Publishes an event with this agent pinned as the source. */
  publish: (target: AgentId, type: string, payload: Record<string, unknown>, ctx: AgentContext) => Promise<AgentEvent>;
  llm: LLMClient;
  now: () => number;
  integrationMode: (id: IntegrationId) => IntegrationMode;
}

export interface TurnResult {
  reply: string;
  status: "ok" | "llm_unavailable" | "error" | "refused";
  taskId?: string;
  approvals: ApprovalRequest[];
  toolCalls: Array<{ name: string; status: ToolExecutionResult["status"] }>;
}

export interface VoiceInput {
  /** Transcript produced by the voice layer (Cartesia STT or labelled browser fallback). */
  transcript?: string;
  confidence?: number;
  audio?: ArrayBuffer;
}

const HISTORY_LIMIT = 60;
const LOW_CONFIDENCE = 0.45;

export abstract class BaseAgent {
  readonly id: AgentId;
  protected readonly registry: ToolRegistry;
  protected readonly store: ScopedAgentStore;

  constructor(
    readonly definition: AgentDefinition,
    protected readonly deps: AgentDeps,
  ) {
    if (deps.store.agentId !== definition.id) {
      throw new AgentError("ISOLATION_VIOLATION", `store scoped to ${deps.store.agentId} given to ${definition.id}`);
    }
    this.id = definition.id;
    this.store = deps.store;
    this.registry = new ToolRegistry(definition.id);
    for (const tool of definition.tools) this.registry.register(tool);
  }

  // ── Hooks for concrete agents ────────────────────────────────────────────

  /**
   * Context blocks prepended to the user's message for one turn. Default: keyword retrieval over this
   * agent's own memory namespaces. Agents with structured memory override this with targeted retrieval.
   */
  protected async turnContext(ctx: AgentContext, text: string): Promise<string[]> {
    const memories = await this.retrieveMemory(ctx, text, { limit: 6 });
    if (!memories.length) return [];
    return [`<relevant_memory>\n${memories.map((m) => `- [${m.namespace}] ${m.text}`).join("\n")}\n</relevant_memory>`];
  }

  /** Agent-specific setup (seed defaults, recurring jobs). Must be idempotent. */
  protected async onInitialize(_ctx: AgentContext): Promise<void> {}

  /** Handle an accepted inbound event. Return the task created, if any. */
  protected async onEvent(event: AgentEvent, _ctx: AgentContext): Promise<{ taskId?: string } | void> {
    throw new AgentError("EVENT_REJECTED", `${this.id} has no handler for ${event.type}`);
  }

  /** Run a scheduled job of one of `definition.jobKinds`. */
  protected async onJob(job: ScheduledJob, _ctx: AgentContext): Promise<void> {
    throw new AgentError("NOT_FOUND", `${this.id} has no handler for job ${job.kind}`);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(ctx: AgentContext): Promise<void> {
    await this.onInitialize(ctx);
    await this.log(ctx, "lifecycle", "info", `${this.definition.displayName} initialized`);
  }

  async processMessage(
    ctx: AgentContext,
    text: string,
    channel: ConversationMessage["channel"] = "text",
  ): Promise<TurnResult> {
    assertCanConverse(ctx, this.id, this.definition.policy);
    const trimmed = text.trim();
    if (!trimmed) throw new AgentError("VALIDATION_FAILED", "message is empty");
    if (trimmed.length > 8000) throw new AgentError("VALIDATION_FAILED", "message is too long");
    ctx = { ...ctx, correlationId: ctx.correlationId ?? newId("cor") };

    const base: TurnResult = { reply: "", status: "ok", approvals: [], toolCalls: [] };

    if (!this.deps.llm.available) {
      await this.saveMessage(ctx, "user", trimmed, trimmed, channel);
      const reply = `${this.definition.displayName} can't think right now because Claude isn't configured. Your message was saved.`;
      await this.log(ctx, "llm", "warn", "LLM unavailable; turn not processed");
      return { ...base, status: "llm_unavailable", reply };
    }

    const history = await this.loadHistory(ctx.userId);
    const userContent = await this.buildUserContent(ctx, trimmed);
    const messages: MessageParam[] = [...history, { role: "user", content: userContent }];
    await this.saveMessage(ctx, "user", userContent, trimmed, channel);

    let task: AgentTask | null = null;
    let final: LLMResponse | null = null;
    try {
      for (let i = 0; ; i++) {
        const capped = i >= this.definition.policy.maxToolIterations;
        const res = await this.deps.llm.complete({
          system: this.definition.systemPrompt,
          tools: this.registry.toClaudeTools(),
          messages,
          effort: this.definition.effort,
          toolChoice: capped ? "none" : "auto",
        });
        await this.log(ctx, "llm", "info", `Model turn (${res.stopReason})`, { model: res.model, iteration: i });
        const toolUses = res.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        const isFinal = res.stopReason !== "tool_use" || toolUses.length === 0 || capped;
        let content = res.content;
        if (isFinal) {
          // Agent-specific server-side checks on the reply the person will see (and hear), before it's stored.
          const raw = textOf(content);
          const filtered = await this.filterReply(ctx, trimmed, raw, base.toolCalls.map((t) => t.name));
          if (filtered !== raw) content = [...content.filter((b) => b.type !== "text"), { type: "text", text: filtered, citations: null } as (typeof content)[number]];
        }
        messages.push({ role: "assistant", content });
        await this.saveMessage(ctx, "assistant", content, textOf(content), channel);

        if (isFinal) {
          final = { ...res, content };
          break;
        }

        task ??= await this.createTask(ctx, summarizeTitle(trimmed), "conversation");
        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const step = await this.addStep(task, { description: use.name, toolName: use.name });
          const result = await this.executeTool(ctx, use.name, use.input, { taskId: task.id, stepId: step.id });
          task = await this.store.getTask(task.id);
          base.toolCalls.push({ name: use.name, status: result.status });
          if (result.status === "approval_required") base.approvals.push(result.approval);
          results.push(toToolResult(use.id, result));
        }
        messages.push({ role: "user", content: results });
        await this.saveMessage(ctx, "user", results, "", "system");
      }
    } catch (err) {
      await this.log(ctx, "error", "error", `Turn failed: ${toErrorMessage(err)}`);
      if (task) await this.finalizeTask(task.id, toErrorMessage(err));
      return {
        ...base,
        status: "error",
        taskId: task?.id,
        reply: "Sorry — I ran into a problem and couldn't finish that. Please try again in a moment.",
      };
    }

    if (task) await this.finalizeTask(task.id);
    if (final.stopReason === "refusal") {
      return { ...base, status: "refused", taskId: task?.id, reply: "I'm not able to help with that request." };
    }
    return { ...base, taskId: task?.id, reply: textOf(final.content) };
  }

  /** Hook for agent-specific checks of the final reply text (default: unchanged). */
  protected async filterReply(_ctx: AgentContext, _userText: string, reply: string, _toolNames: string[]): Promise<string> {
    void _ctx;
    void _userText;
    void _toolNames;
    return reply;
  }

  async processVoiceInput(ctx: AgentContext, input: VoiceInput): Promise<TurnResult> {
    if (!input.transcript) {
      throw new AgentError(
        "INTEGRATION_UNAVAILABLE",
        "Server-side speech recognition is not available; send a transcript from the voice layer",
      );
    }
    if (input.confidence !== undefined && input.confidence < LOW_CONFIDENCE) {
      return {
        reply: "Sorry, I didn't quite catch that. Could you say it again?",
        status: "ok",
        approvals: [],
        toolCalls: [],
      };
    }
    return this.processMessage(ctx, input.transcript, "voice");
  }

  /** Keyword retrieval over this agent's own memory namespaces only. */
  async retrieveMemory(
    ctx: AgentContext,
    query: string,
    opts: { namespaces?: string[]; limit?: number } = {},
  ): Promise<MemoryRecord[]> {
    const namespaces = opts.namespaces ?? this.definition.memoryNamespaces;
    const records = (await Promise.all(namespaces.map((ns) => this.store.listMemory(ctx.userId, ns)))).flat();
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const scored = records
      .map((r) => {
        const hay = r.text.toLowerCase();
        return { r, score: terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0) };
      })
      .filter((x) => terms.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score || b.r.updatedAt - a.r.updatedAt);
    return scored.slice(0, opts.limit ?? 8).map((x) => x.r);
  }

  /** Instantiate a task from one of this agent's workflow templates. */
  async planTask(
    ctx: AgentContext,
    workflowId: string,
    origin: AgentTask["origin"] = "workflow",
  ): Promise<AgentTask> {
    const wf = this.definition.workflows.find((w) => w.id === workflowId);
    if (!wf) throw new AgentError("NOT_FOUND", `${this.id} has no workflow "${workflowId}"`);
    const task = await this.createTask(ctx, wf.title, origin, workflowId);
    for (const s of wf.steps) await this.addStep(task, s);
    await this.log(ctx, "lifecycle", "info", `Planned "${wf.title}" (${wf.steps.length} steps)`, { taskId: task.id });
    return this.store.getTask(task.id);
  }

  async executeTool(
    ctx: AgentContext,
    name: string,
    input: unknown,
    link: { taskId?: string; stepId?: string; approvalId?: string } = {},
  ): Promise<ToolExecutionResult> {
    if (link.stepId && link.taskId) await this.updateStep(link.taskId, link.stepId, { status: "running" });
    const result = await this.registry.execute(name, input, this.toolContext(ctx, link), {
      approvalId: link.approvalId,
      approvalTtlMs: this.definition.policy.approvalTtlMs,
    });
    if (link.stepId && link.taskId) {
      await this.updateStep(link.taskId, link.stepId, stepPatch(result));
    }
    return result;
  }

  /** Explicitly request approval for a tool call (e.g. from a workflow or event handler). */
  async requestApproval(
    ctx: AgentContext,
    toolName: string,
    input: unknown,
    link: { taskId?: string; stepId?: string } = {},
  ): Promise<ApprovalRequest> {
    const tool = this.registry.get(toolName);
    if (!this.registry.requiresApproval(tool, input)) {
      throw new AgentError("VALIDATION_FAILED", `${toolName} does not require approval`);
    }
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new AgentError("VALIDATION_FAILED", `invalid input for ${toolName}`);
    const approval = await this.registry.createApproval(
      tool,
      parsed.data,
      this.toolContext(ctx, link),
      this.definition.policy.approvalTtlMs,
    );
    if (link.taskId && link.stepId) {
      await this.updateStep(link.taskId, link.stepId, { status: "awaiting_approval", approvalId: approval.id });
    }
    await this.log(ctx, "approval", "info", `Approval requested for ${toolName}`, { approvalId: approval.id });
    return approval;
  }

  /** Approve or deny a pending approval; approved actions execute immediately. */
  async resolveApproval(
    ctx: AgentContext,
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<{ approval: ApprovalRequest; result?: ToolExecutionResult }> {
    await assertCanApprove(ctx, this.id, this.definition.policy, this.deps.permissions);
    const approval = await this.store.getApproval(approvalId);
    if (approval.userId !== ctx.userId) throw new AgentError("PERMISSION_DENIED", "approval belongs to another user");
    if (approval.status !== "pending") throw new AgentError("APPROVAL_INVALID", `approval is already ${approval.status}`);
    if (approval.expiresAt < this.deps.now()) {
      await this.store.saveApproval({ ...approval, status: "expired" });
      throw new AgentError("APPROVAL_INVALID", "approval has expired");
    }

    const decided: ApprovalRequest = {
      ...approval,
      status: decision === "approve" ? "approved" : "denied",
      decidedAt: this.deps.now(),
      decidedBy: ctx.actor.id,
    };
    // Atomic pending → decided: of two concurrent decisions (approve+approve, or approve+deny) only one wins.
    const won = await this.store.transitionApproval(approvalId, "pending", {
      status: decided.status,
      decidedAt: decided.decidedAt,
      decidedBy: decided.decidedBy,
      now: this.deps.now(),
    });
    if (!won) throw new AgentError("APPROVAL_INVALID", "approval was already decided or has expired");
    // Summaries can contain sensitive details (medication names); the log keeps ids only.
    await this.log(ctx, "approval", "info", `${decision === "approve" ? "Approved" : "Denied"} ${approval.toolName}`, {
      approvalId,
      by: ctx.actor.id,
    });

    if (decision === "deny") {
      if (approval.taskId && approval.stepId) {
        await this.updateStep(approval.taskId, approval.stepId, { status: "skipped", error: "Denied by user" });
        await this.finalizeTask(approval.taskId);
      }
      await this.addNotice(ctx.userId, `The user DENIED: ${approval.summary}. Do not retry unless asked.`);
      return { approval: decided };
    }

    // Execute on the user's behalf; the approval record carries who authorized it.
    const execCtx: AgentContext = {
      userId: ctx.userId,
      actor: { id: `agent:${this.id}`, role: "system" },
      correlationId: ctx.correlationId,
    };
    const result = await this.executeTool(execCtx, approval.toolName, approval.input, {
      taskId: approval.taskId,
      stepId: approval.stepId,
      approvalId,
    });
    if (approval.taskId) await this.finalizeTask(approval.taskId);
    await this.addNotice(
      ctx.userId,
      result.status === "success"
        ? `The user APPROVED "${approval.summary}" and it completed: ${truncate(JSON.stringify(result.output), 600)}`
        : `The user approved "${approval.summary}" but it failed: ${result.status === "error" ? result.error : result.status}`,
    );
    return { approval: await this.store.getApproval(approvalId), result };
  }

  /** Entry point for accepted cross-agent events (called by the runtime's dispatcher). */
  async handleEvent(event: AgentEvent): Promise<{ taskId?: string } | void> {
    if (event.targetAgent !== this.id) {
      throw new AgentError("ISOLATION_VIOLATION", `event for ${event.targetAgent} delivered to ${this.id}`);
    }
    const ctx: AgentContext = {
      userId: event.userId,
      actor: { id: `agent:${event.sourceAgent}`, role: "system" },
      correlationId: event.correlationId,
    };
    await this.log(ctx, "event", "info", `Received ${event.type} from ${event.sourceAgent}`, { eventId: event.id });
    return this.onEvent(event, ctx);
  }

  async scheduleTask(
    ctx: AgentContext,
    job: { kind: string; runAt: number; everyMs?: number; payload?: Record<string, unknown> },
  ): Promise<ScheduledJob> {
    if (!this.definition.jobKinds.includes(job.kind)) {
      throw new AgentError("VALIDATION_FAILED", `${this.id} cannot schedule "${job.kind}"`);
    }
    if (!Number.isFinite(job.runAt)) throw new AgentError("VALIDATION_FAILED", "runAt must be a timestamp");
    if (job.everyMs !== undefined && job.everyMs < 60_000) {
      throw new AgentError("VALIDATION_FAILED", "repeat interval must be at least one minute");
    }
    const scheduled: ScheduledJob = {
      id: newId("job"),
      agentId: this.id,
      userId: ctx.userId,
      kind: job.kind,
      runAt: job.runAt,
      everyMs: job.everyMs,
      payload: job.payload ?? {},
      status: "scheduled",
    };
    await this.store.saveJob(scheduled);
    await this.log(ctx, "schedule", "info", `Scheduled ${job.kind}`, { jobId: scheduled.id, runAt: job.runAt });
    return scheduled;
  }

  /** Run one due job (called by the runtime scheduler / Convex cron). */
  async runJob(jobId: string): Promise<ScheduledJob> {
    const job = await this.store.getJob(jobId);
    if (job.status !== "scheduled") return job;
    const ctx: AgentContext = { userId: job.userId, actor: { id: `agent:${this.id}`, role: "system" } };
    await this.store.saveJob({ ...job, status: "running" });
    let next: ScheduledJob;
    try {
      await this.onJob(job, ctx);
      const now = this.deps.now();
      next = job.everyMs
        ? { ...job, status: "scheduled", lastRunAt: now, runAt: job.runAt + job.everyMs * Math.max(1, Math.ceil((now - job.runAt) / job.everyMs)) }
        : { ...job, status: "done", lastRunAt: now };
      await this.log(ctx, "schedule", "info", `Ran ${job.kind}`, { jobId });
    } catch (err) {
      next = { ...job, status: job.everyMs ? "scheduled" : "failed", lastError: toErrorMessage(err), lastRunAt: this.deps.now() };
      if (job.everyMs) next.runAt = job.runAt + job.everyMs;
      await this.log(ctx, "error", "error", `Job ${job.kind} failed: ${toErrorMessage(err)}`, { jobId });
    }
    await this.store.saveJob(next);
    return next;
  }

  async getTaskStatus(ctx: AgentContext, taskId: string): Promise<AgentTask> {
    const task = await this.store.getTask(taskId);
    if (task.userId !== ctx.userId) throw new AgentError("PERMISSION_DENIED", "task belongs to another user");
    return task;
  }

  // ── Read models for the UI ───────────────────────────────────────────────

  listTasks(ctx: AgentContext, status?: AgentTask["status"][]) {
    return this.store.listTasks({ userId: ctx.userId, status });
  }
  listApprovals(ctx: AgentContext, status: ApprovalRequest["status"][] = ["pending"]) {
    return this.store.listApprovals({ userId: ctx.userId, status });
  }
  async listConversation(ctx: AgentContext) {
    return (await this.store.listMessages(ctx.userId)).filter((m) => m.text);
  }
  listTools() {
    return this.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      integrations: t.integrations ?? [],
    }));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  protected toolContext(ctx: AgentContext, link: { taskId?: string; stepId?: string } = {}): ToolContext {
    return {
      agentId: this.id,
      ctx,
      store: this.store,
      now: this.deps.now,
      taskId: link.taskId,
      stepId: link.stepId,
      emit: (target, type, payload) => this.deps.publish(target, type, payload, ctx),
      integrationMode: this.deps.integrationMode,
    };
  }

  protected async log(
    ctx: AgentContext,
    kind: Parameters<ScopedAgentStore["appendLog"]>[0]["kind"],
    level: "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ) {
    await this.store.appendLog({
      id: newId("log"),
      userId: ctx.userId,
      kind,
      level,
      message,
      data,
      correlationId: ctx.correlationId,
      at: this.deps.now(),
    });
  }

  protected async createTask(
    ctx: AgentContext,
    title: string,
    origin: AgentTask["origin"],
    workflowId?: string,
  ): Promise<AgentTask> {
    const now = this.deps.now();
    const task: AgentTask = {
      id: newId("task"),
      agentId: this.id,
      userId: ctx.userId,
      title,
      status: origin === "workflow" ? "planned" : "running",
      steps: [],
      origin,
      workflowId,
      correlationId: ctx.correlationId,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveTask(task);
    return task;
  }

  protected async addStep(task: AgentTask, step: { description: string; toolName?: string }): Promise<TaskStep> {
    const fresh = await this.store.getTask(task.id);
    const s: TaskStep = { id: newId("step"), ...step, status: "pending", attempts: 0 };
    await this.store.saveTask({ ...fresh, steps: [...fresh.steps, s], updatedAt: this.deps.now() });
    return s;
  }

  protected async updateStep(taskId: string, stepId: string, patch: Partial<TaskStep>) {
    const task = await this.store.getTask(taskId);
    const steps = task.steps.map((s) =>
      s.id === stepId
        ? { ...s, ...patch, attempts: patch.status === "running" ? s.attempts + 1 : s.attempts }
        : s,
    );
    const status: AgentTask["status"] = steps.some((s) => s.status === "awaiting_approval")
      ? "awaiting_approval"
      : task.status === "planned" || task.status === "awaiting_approval"
        ? "running"
        : task.status;
    await this.store.saveTask({ ...task, steps, status, updatedAt: this.deps.now() });
  }

  /** Derive a task's terminal status from its steps. */
  protected async finalizeTask(taskId: string, error?: string) {
    const task = await this.store.getTask(taskId);
    let status: AgentTask["status"];
    if (error) status = "failed";
    else if (task.steps.some((s) => s.status === "awaiting_approval")) status = "awaiting_approval";
    else if (task.steps.some((s) => s.status === "pending" || s.status === "running")) status = "running";
    else if (task.steps.length > 0 && task.steps.every((s) => s.status === "failed")) status = "failed";
    else status = "completed";
    const lastError = error ?? [...task.steps].reverse().find((s) => s.status === "failed")?.error;
    await this.store.saveTask({ ...task, status, error: lastError, updatedAt: this.deps.now() });
  }

  private async saveMessage(
    ctx: AgentContext,
    role: ConversationMessage["role"],
    content: MessageParam["content"],
    text: string,
    channel: ConversationMessage["channel"],
  ) {
    await this.store.appendMessage({ id: newId("msg"), userId: ctx.userId, role, content, text, channel, at: this.deps.now() });
  }

  /** Replays stored history, starting at a plain user turn so tool_use/tool_result pairs stay intact. */
  private async loadHistory(userId: string): Promise<MessageParam[]> {
    const stored = await this.store.listMessages(userId, HISTORY_LIMIT);
    const start = stored.findIndex((m) => m.role === "user" && m.channel !== "system");
    if (start < 0) return [];
    const msgs = stored.slice(start).map((m) => ({ role: m.role, content: replayable(m.role, m.content) }) as MessageParam);
    // A turn that crashed mid-loop can leave a trailing user or tool_use turn; trim to the last assistant reply.
    while (msgs.length && (msgs[msgs.length - 1].role !== "assistant" || hasToolUse(msgs[msgs.length - 1]))) {
      msgs.pop();
    }
    return msgs;
  }

  private async buildUserContent(ctx: AgentContext, text: string): Promise<Anthropic.Beta.Messages.BetaContentBlockParam[]> {
    const blocks: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    const notices = await this.drainNotices(ctx.userId);
    const context: string[] = [];
    if (notices.length) context.push(`<updates_since_last_turn>\n${notices.join("\n")}\n</updates_since_last_turn>`);
    context.push(...(await this.turnContext(ctx, text)));
    context.push(`<now>${new Date(this.deps.now()).toISOString()}</now>`);
    blocks.push({ type: "text", text: context.join("\n") });
    blocks.push({ type: "text", text });
    return blocks;
  }

  private noticeNamespace() {
    return `${this.id}.notices`;
  }

  private async addNotice(userId: string, text: string) {
    const now = this.deps.now();
    await this.store.putMemory({
      id: newId("mem"),
      userId,
      namespace: this.noticeNamespace(),
      key: newId("notice"),
      value: text,
      text,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async drainNotices(userId: string): Promise<string[]> {
    const ns = this.noticeNamespace();
    if (!this.store.memoryNamespaces.includes(ns)) return [];
    const notices = (await this.store.listMemory(userId, ns)).sort((a, b) => a.createdAt - b.createdAt);
    for (const n of notices) await this.store.deleteMemory(userId, ns, n.key);
    return notices.map((n) => n.text);
  }
}

/**
 * Completed earlier turns are replayed without `thinking` blocks: their signatures are bound to the exact prefix they
 * were created with, which changes as the history window slides or a forgotten value is redacted (the API then
 * rejects the whole request). Thinking from finished turns isn't needed; the current turn's tool loop keeps its own.
 */
function replayable(role: ConversationMessage["role"], content: MessageParam["content"]): MessageParam["content"] {
  if (role !== "assistant" || !Array.isArray(content)) return content;
  const kept = content.filter((b) => (b as { type?: string }).type !== "thinking" && (b as { type?: string }).type !== "redacted_thinking");
  return kept.length ? kept : [{ type: "text", text: "(no reply)" }];
}

/** Every agent gets an internal notices namespace in addition to its declared ones. */
export function namespacesFor(def: Pick<AgentDefinition, "id" | "memoryNamespaces">): string[] {
  return [...def.memoryNamespaces, `${def.id}.notices`];
}

function textOf(content: ContentBlockLike[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
type ContentBlockLike = { type: string };

function hasToolUse(m: MessageParam): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use");
}

function toToolResult(id: string, r: ToolExecutionResult): Anthropic.Beta.Messages.BetaToolResultBlockParam {
  switch (r.status) {
    case "success":
      return { type: "tool_result", tool_use_id: id, content: JSON.stringify(r.output ?? null) };
    case "approval_required":
      return {
        type: "tool_result",
        tool_use_id: id,
        content: JSON.stringify({
          status: "awaiting_user_approval",
          approvalId: r.approval.id,
          summary: r.approval.summary,
          note: "Not executed yet. It runs only after the user approves it in the Approvals panel. Tell the user what you are asking them to approve.",
        }),
      };
    case "error":
      return { type: "tool_result", tool_use_id: id, is_error: true, content: `${r.code}: ${r.error}` };
  }
}

function stepPatch(r: ToolExecutionResult): Partial<TaskStep> {
  switch (r.status) {
    case "success":
      return { status: "succeeded", output: r.output, error: undefined };
    case "approval_required":
      return { status: "awaiting_approval", approvalId: r.approval.id };
    case "error":
      return { status: "failed", error: r.error };
  }
}

function summarizeTitle(text: string) {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 70 ? `${oneLine.slice(0, 67)}…` : oneLine;
}

function truncate(s: string | undefined, n: number) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
