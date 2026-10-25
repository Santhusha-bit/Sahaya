import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getIntegration, type IntegrationId, type IntegrationMode } from "@/integrations/status";
import { hashValue, newId, stableStringify } from "@/lib/ids";
import type { ScopedAgentStore } from "./AgentStore";
import { AgentError, isAgentError, toErrorMessage } from "./errors";
import type { ActorRole, AgentContext, AgentEvent, AgentId, ApprovalRequest } from "./types";

export type ToolRisk = "read" | "write" | "sensitive";

export interface ToolContext {
  agentId: AgentId;
  ctx: AgentContext;
  store: ScopedAgentStore;
  now: () => number;
  taskId?: string;
  stepId?: string;
  /** Publish a cross-agent event through the bus (consent- and schema-checked there). */
  emit: (target: AgentId, type: string, payload: Record<string, unknown>) => Promise<AgentEvent>;
  integrationMode: (id: IntegrationId) => IntegrationMode;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType, O = unknown> {
  name: string;
  /** The only agent allowed to register and execute this tool. */
  owner: AgentId;
  description: string;
  input: S;
  risk: ToolRisk;
  /** Approval gate. Sensitive tools always require approval regardless of this flag. */
  requiresApproval?: boolean | ((input: z.infer<S>) => boolean);
  /** Human-readable description of the action, shown on the approval card. */
  summarize?: (input: z.infer<S>) => string;
  allowedRoles?: ActorRole[];
  /** External services this tool needs. Unavailable integrations fail fast and honestly. */
  integrations?: IntegrationId[];
  maxRetries?: number;
  /**
   * Optional server-side check of current state, run before an approval is requested and again
   * immediately before an approved call executes (e.g. "the cart still matches what was reviewed").
   */
  precheck?: (input: z.infer<S>, tc: ToolContext) => Promise<void>;
  handler: (input: z.infer<S>, tc: ToolContext) => Promise<O>;
}

// Variance helper so heterogeneous tools can live in one registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any, any>;

export function defineTool<S extends z.ZodType, O>(def: ToolDefinition<S, O>): ToolDefinition<S, O> {
  return def;
}

export type ToolExecutionResult =
  | { status: "success"; output: unknown; attempts: number }
  | { status: "approval_required"; approval: ApprovalRequest }
  | { status: "error"; code: string; error: string; attempts: number };

export interface ExecuteOptions {
  /** An approved ApprovalRequest authorizing exactly this call. */
  approvalId?: string;
  sleep?: (ms: number) => Promise<void>;
  approvalTtlMs?: number;
}

const DEFAULT_ROLES: ActorRole[] = ["older_adult", "system"];

function inputFields(input: unknown): string[] {
  return input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [];
}

/**
 * A single agent's tool registry. Registries are owned: a tool declared for one agent can
 * never be registered with, listed by, or executed through another agent's registry.
 */
export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  constructor(readonly owner: AgentId) {}

  register(tool: AnyTool): this {
    if (tool.owner !== this.owner) {
      throw new AgentError(
        "ISOLATION_VIOLATION",
        `tool "${tool.name}" belongs to ${tool.owner}; cannot register with ${this.owner}`,
      );
    }
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool "${tool.name}" in ${this.owner}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string) {
    return this.tools.has(name);
  }

  get(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (!tool) throw new AgentError("TOOL_NOT_FOUND", `${this.owner} agent has no tool "${name}"`);
    return tool;
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  requiresApproval(tool: AnyTool, input: unknown): boolean {
    if (tool.risk === "sensitive") return true;
    if (typeof tool.requiresApproval === "function") return tool.requiresApproval(input);
    return Boolean(tool.requiresApproval);
  }

  /** Tool definitions in Claude Messages API form. */
  toClaudeTools(): Anthropic.Beta.Messages.BetaTool[] {
    return this.list().map((t) => {
      const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
      return {
        name: t.name,
        description: t.description,
        input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
      };
    });
  }

  async execute(
    name: string,
    rawInput: unknown,
    tc: ToolContext,
    opts: ExecuteOptions = {},
  ): Promise<ToolExecutionResult> {
    if (tc.agentId !== this.owner || tc.store.agentId !== this.owner) {
      throw new AgentError("ISOLATION_VIOLATION", `context for ${tc.agentId} used with ${this.owner} registry`);
    }
    const log = (kind: "tool_call" | "tool_result" | "error" | "approval", message: string, data?: unknown) =>
      tc.store.appendLog({
        id: newId("log"),
        userId: tc.ctx.userId,
        kind,
        level: kind === "error" ? "error" : "info",
        message,
        data,
        correlationId: tc.ctx.correlationId,
        at: tc.now(),
      });

    let tool: AnyTool;
    try {
      tool = this.get(name);
    } catch (err) {
      await log("error", `Unknown tool ${name}`);
      return { status: "error", code: "TOOL_NOT_FOUND", error: toErrorMessage(err), attempts: 0 };
    }

    const roles = tool.allowedRoles ?? DEFAULT_ROLES;
    if (!roles.includes(tc.ctx.actor.role)) {
      await log("error", `${tc.ctx.actor.role} may not run ${name}`);
      return { status: "error", code: "PERMISSION_DENIED", error: `${tc.ctx.actor.role} may not run ${name}`, attempts: 0 };
    }

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const error = z.prettifyError(parsed.error);
      await log("error", `Invalid input for ${name}`, { error });
      return { status: "error", code: "VALIDATION_FAILED", error, attempts: 0 };
    }
    const input = parsed.data;

    for (const integration of tool.integrations ?? []) {
      if (tc.integrationMode(integration) === "unavailable") {
        const status = getIntegration(integration);
        const error = `${status.name} is unavailable: ${status.detail}`;
        await log("error", error);
        return { status: "error", code: "INTEGRATION_UNAVAILABLE", error, attempts: 0 };
      }
    }

    if (tool.precheck) {
      try {
        await tool.precheck(input, tc);
      } catch (err) {
        const code = isAgentError(err) ? err.code : "VALIDATION_FAILED";
        await log("error", `Precheck failed for ${name}`, { code });
        return { status: "error", code, error: toErrorMessage(err), attempts: 0 };
      }
    }

    if (this.requiresApproval(tool, input)) {
      if (!opts.approvalId) {
        const approval = await this.createApproval(tool, input, tc, opts.approvalTtlMs);
        // Log ids only: summaries can name medications or products.
        await log("approval", `Approval requested for ${name}`, { approvalId: approval.id });
        return { status: "approval_required", approval };
      }
      const check = await this.consumeApproval(opts.approvalId, name, input, tc);
      if (check) {
        await log("error", check.error);
        return { ...check, attempts: 0 };
      }
    }

    const maxRetries = tool.maxRetries ?? 1;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // Never log raw tool input (medications, allergies, addresses); a hash still ties the log to the call.
    await log("tool_call", `Running ${name}`, { inputHash: hashValue(input), fields: inputFields(input) });
    for (let attempt = 1; ; attempt++) {
      try {
        const output = await tool.handler(input, tc);
        await log("tool_result", `${name} succeeded`, { attempt });
        return { status: "success", output, attempts: attempt };
      } catch (err) {
        const retryable = isAgentError(err) ? err.retryable : false;
        const code = isAgentError(err) ? err.code : "TOOL_FAILED";
        if (retryable && attempt <= maxRetries) {
          // Error text can contain personal details (product or medication names); log codes only.
          await log("error", `${name} failed (attempt ${attempt}), retrying`, { code });
          await sleep(200 * attempt);
          continue;
        }
        await log("error", `${name} failed`, { attempt, code });
        return { status: "error", code, error: toErrorMessage(err), attempts: attempt };
      }
    }
  }

  /** Persists a pending approval bound to this exact tool + validated input. */
  async createApproval(
    tool: AnyTool,
    input: unknown,
    tc: ToolContext,
    ttlMs = 24 * 60 * 60 * 1000,
  ): Promise<ApprovalRequest> {
    if (tool.owner !== this.owner) {
      throw new AgentError("ISOLATION_VIOLATION", `cannot request approval for ${tool.owner} tool`);
    }
    const approval: ApprovalRequest = {
      id: newId("apr"),
      agentId: this.owner,
      userId: tc.ctx.userId,
      taskId: tc.taskId,
      stepId: tc.stepId,
      toolName: tool.name,
      input,
      inputHash: hashValue(input),
      summary: tool.summarize?.(input) ?? `Run ${tool.name}`,
      status: "pending",
      requestedBy: tc.ctx.actor.id,
      createdAt: tc.now(),
      expiresAt: tc.now() + ttlMs,
    };
    await tc.store.saveApproval(approval);
    return approval;
  }

  /** Validates and atomically consumes an approval. Returns an error result, or null if valid. */
  private async consumeApproval(
    approvalId: string,
    name: string,
    input: unknown,
    tc: ToolContext,
  ): Promise<{ status: "error"; code: string; error: string } | null> {
    const fail = (error: string) => ({ status: "error" as const, code: "APPROVAL_INVALID", error });
    let approval: ApprovalRequest;
    try {
      approval = await tc.store.getApproval(approvalId);
    } catch (err) {
      return fail(toErrorMessage(err));
    }
    if (approval.userId !== tc.ctx.userId) return fail("approval belongs to a different user");
    if (approval.toolName !== name) return fail(`approval was for ${approval.toolName}, not ${name}`);
    if (approval.status !== "approved") return fail(`approval is ${approval.status}`);
    if (approval.expiresAt < tc.now()) return fail("approval has expired");
    if (approval.inputHash !== hashValue(input) || stableStringify(approval.input) !== stableStringify(input)) {
      return fail("input differs from what was approved");
    }
    // Atomic single use: two concurrent executions can't both pass. The store re-checks owner, tool, input hash
    // and expiry inside the same transaction (no gap between the checks above and the consume).
    const consumed = await tc.store.consumeApproval(approval.id, { userId: tc.ctx.userId, toolName: name, inputHash: hashValue(input), now: tc.now() });
    if (!consumed) return fail("approval was already used");
    return null;
  }
}
