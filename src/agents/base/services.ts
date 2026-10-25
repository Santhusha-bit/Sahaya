import { id, now } from "@/lib/id";
import type {
  AgentId,
  AgentTask,
  Approval,
  ApprovalStore,
  TaskStatus,
  TaskStep,
  TaskStore,
} from "./types";

/** Thin, agent-scoped wrapper over the task store. */
export class TaskService {
  constructor(
    private readonly store: TaskStore,
    private readonly agentId: AgentId,
    private readonly userId: string,
  ) {}

  async create(input: {
    title: string;
    description?: string;
    steps?: string[];
    correlationId?: string;
    status?: TaskStatus;
    result?: string;
  }): Promise<AgentTask> {
    const steps: TaskStep[] = (input.steps ?? []).map((label) => ({
      id: id("step"),
      label,
      status: "pending",
    }));
    const task: AgentTask = {
      id: id("task"),
      agentId: this.agentId,
      userId: this.userId,
      title: input.title,
      description: input.description,
      status: input.status ?? "planning",
      steps,
      correlationId: input.correlationId,
      result: input.result,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.put(task);
  }

  async get(taskId: string): Promise<AgentTask | null> {
    const t = await this.store.get(taskId);
    if (!t || t.agentId !== this.agentId || t.userId !== this.userId) return null;
    return t;
  }

  async setStatus(taskId: string, status: TaskStatus, result?: string): Promise<AgentTask | null> {
    return this.store.patch(taskId, { status, result, updatedAt: now() });
  }

  async advanceStep(taskId: string, label: string, status: TaskStep["status"], detail?: string): Promise<AgentTask | null> {
    const task = await this.get(taskId);
    if (!task) return null;
    const steps = task.steps.map((s) => (s.label === label ? { ...s, status, detail } : s));
    return this.store.patch(taskId, { steps, updatedAt: now() });
  }

  async list(): Promise<AgentTask[]> {
    return this.store.list({ userId: this.userId, agentId: this.agentId });
  }
}

/** Agent-scoped wrapper over the approval store. */
export class ApprovalService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly agentId: AgentId,
    private readonly userId: string,
  ) {}

  async request(input: {
    toolName: string;
    toolInput: unknown;
    title: string;
    description: string;
    correlationId?: string;
  }): Promise<Approval> {
    const approval: Approval = {
      id: id("appr"),
      agentId: this.agentId,
      userId: this.userId,
      toolName: input.toolName,
      input: input.toolInput,
      title: input.title,
      description: input.description,
      status: "pending",
      correlationId: input.correlationId,
      createdAt: now(),
    };
    return this.store.put(approval);
  }

  async get(approvalId: string): Promise<Approval | null> {
    const a = await this.store.get(approvalId);
    if (!a || a.agentId !== this.agentId || a.userId !== this.userId) return null;
    return a;
  }

  /** Expire a still-pending approval owned by this agent (e.g. its cart was replaced). */
  async expire(approvalId: string): Promise<Approval | null> {
    const a = await this.get(approvalId);
    if (!a || a.status !== "pending") return null;
    return this.store.patch(approvalId, { status: "expired", decidedAt: now() });
  }

  async list(status?: Approval["status"]): Promise<Approval[]> {
    return this.store.list({ userId: this.userId, agentId: this.agentId, status });
  }
}
