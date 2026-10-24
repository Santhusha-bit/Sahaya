import type { z } from "zod";

/** The four independent agents. */
export type AgentId = "guardian" | "care" | "wellness" | "finance";

export const AGENT_IDS: AgentId[] = ["guardian", "care", "wellness", "finance"];

export function isAgentId(v: string): v is AgentId {
  return (AGENT_IDS as string[]).includes(v);
}

export type Role = "user" | "assistant" | "system";

export interface ConversationMessage {
  id: string;
  agentId: AgentId;
  userId: string;
  role: Role;
  content: string;
  createdAt: number;
  /** Tool activity attached to an assistant turn, for the activity log. */
  toolCalls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  id: string;
  toolName: string;
  input: unknown;
  status: "success" | "error" | "awaiting_approval";
  summary: string;
  output?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  approvalId?: string;
}

/** ---- Memory ---- */

export interface MemoryRecord {
  id: string;
  /** Namespace is an agent id or "shared". Enforces isolation. */
  namespace: AgentId | "shared";
  collection: string;
  userId: string;
  data: Record<string, unknown>;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryQuery {
  namespace: AgentId | "shared";
  userId: string;
  collection?: string;
  tag?: string;
  limit?: number;
}

export interface MemoryStore {
  put(rec: MemoryRecord): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord | null>;
  list(query: MemoryQuery): Promise<MemoryRecord[]>;
  patch(id: string, data: Record<string, unknown>): Promise<MemoryRecord | null>;
  remove(id: string): Promise<boolean>;
}

/** ---- Events (cross-agent collaboration bus) ---- */

export type EventStatus =
  | "pending"
  | "accepted"
  | "completed"
  | "rejected"
  | "blocked";

export interface AgentEvent {
  id: string;
  correlationId: string;
  sourceAgent: AgentId;
  targetAgent: AgentId;
  type: string;
  userId: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventQuery {
  userId: string;
  targetAgent?: AgentId;
  sourceAgent?: AgentId;
  correlationId?: string;
  status?: EventStatus;
  limit?: number;
}

export interface EventStore {
  put(evt: AgentEvent): Promise<AgentEvent>;
  list(query: EventQuery): Promise<AgentEvent[]>;
  patch(id: string, patch: Partial<AgentEvent>): Promise<AgentEvent | null>;
}

/** ---- Tasks ---- */

export type TaskStatus =
  | "planning"
  | "in_progress"
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TaskStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface AgentTask {
  id: string;
  agentId: AgentId;
  userId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  steps: TaskStep[];
  correlationId?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskStore {
  put(task: AgentTask): Promise<AgentTask>;
  get(id: string): Promise<AgentTask | null>;
  list(query: { userId: string; agentId?: AgentId; limit?: number }): Promise<AgentTask[]>;
  patch(id: string, patch: Partial<AgentTask>): Promise<AgentTask | null>;
}

/** ---- Approvals ---- */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  agentId: AgentId;
  userId: string;
  toolName: string;
  input: unknown;
  title: string;
  description: string;
  status: ApprovalStatus;
  correlationId?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface ApprovalStore {
  put(a: Approval): Promise<Approval>;
  get(id: string): Promise<Approval | null>;
  list(query: { userId: string; agentId?: AgentId; status?: ApprovalStatus; limit?: number }): Promise<Approval[]>;
  patch(id: string, patch: Partial<Approval>): Promise<Approval | null>;
}

/** ---- Conversations ---- */

export interface ConversationStore {
  append(msg: ConversationMessage): Promise<ConversationMessage>;
  history(query: { userId: string; agentId: AgentId; limit?: number }): Promise<ConversationMessage[]>;
}

/** Full persistence surface. */
export interface DataLayer {
  memory: MemoryStore;
  events: EventStore;
  tasks: TaskStore;
  approvals: ApprovalStore;
  conversations: ConversationStore;
  backend: "convex" | "memory";
}

/** ---- Tools ---- */

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  approvalId?: string;
}

export interface AgentTool<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** When true, the runtime creates an Approval and defers execution. */
  requiresApproval?: boolean | ((input: I) => boolean);
  /** One-line human description of a pending approval. */
  approvalSummary?: (input: I) => { title: string; description: string };
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}

/** Context handed to every tool execution. Enforces agent scoping. */
export interface ToolContext {
  agentId: AgentId;
  userId: string;
  correlationId: string;
  memory: ScopedMemory;
  bus: import("./AgentEventBus").AgentEventBus;
  tasks: import("./services").TaskService;
  approvals: import("./services").ApprovalService;
  log: (line: string) => void;
}

/** Memory handle scoped to a single agent — cannot address another agent's namespace. */
export interface ScopedMemory {
  readonly agentId: AgentId;
  readonly userId: string;
  save(collection: string, data: Record<string, unknown>, opts?: { tags?: string[] }): Promise<MemoryRecord>;
  list(collection: string, opts?: { tag?: string; limit?: number }): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  update(id: string, data: Record<string, unknown>): Promise<MemoryRecord | null>;
  remove(id: string): Promise<boolean>;
  /** Shared household/user data, only if the agent holds the shared:* permission. */
  readShared(collection: string, opts?: { limit?: number }): Promise<MemoryRecord[]>;
  writeShared(collection: string, data: Record<string, unknown>): Promise<MemoryRecord>;
}
