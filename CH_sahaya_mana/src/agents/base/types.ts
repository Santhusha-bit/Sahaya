import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_IDS = ["guardian", "care", "wellness", "finance"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export type ActorRole = "older_adult" | "caregiver" | "system";

/** Who is acting, on whose behalf. Every runtime call carries one. */
export interface AgentContext {
  /** The older adult whose data and agents are being accessed. */
  userId: string;
  actor: { id: string; role: ActorRole };
  correlationId?: string;
}

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

export interface ConversationMessage {
  id: string;
  agentId: AgentId;
  userId: string;
  role: "user" | "assistant";
  /** Full API content (including thinking/tool blocks) so history replays unchanged. */
  content: MessageParam["content"];
  /** Plain-text rendering for the UI. Empty for tool-result-only turns. */
  text: string;
  channel: "text" | "voice" | "system";
  at: number;
}

export type TaskStatus =
  | "planned"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "skipped";

export interface TaskStep {
  id: string;
  description: string;
  toolName?: string;
  status: StepStatus;
  attempts: number;
  approvalId?: string;
  output?: unknown;
  error?: string;
}

export interface AgentTask {
  id: string;
  agentId: AgentId;
  userId: string;
  title: string;
  status: TaskStatus;
  steps: TaskStep[];
  /** Origin of the task: a conversation turn, a workflow template, an inbound event, or a schedule. */
  origin: "conversation" | "workflow" | "event" | "schedule";
  workflowId?: string;
  correlationId?: string;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface ApprovalRequest {
  id: string;
  agentId: AgentId;
  userId: string;
  taskId?: string;
  stepId?: string;
  toolName: string;
  input: unknown;
  /** Stable hash of the input, so an approval can't be replayed with different arguments. */
  inputHash: string;
  summary: string;
  status: ApprovalStatus;
  requestedBy: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedBy?: string;
}

export type LogKind =
  | "lifecycle"
  | "llm"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "event"
  | "schedule"
  | "memory"
  /** Security-relevant actions: caregiver grants/revocations, caregiver views and decisions. No sensitive payloads. */
  | "audit"
  | "error";

export interface ExecutionLog {
  id: string;
  agentId: AgentId;
  userId: string;
  kind: LogKind;
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
  correlationId?: string;
  at: number;
}

export interface MemoryRecord {
  id: string;
  agentId: AgentId;
  userId: string;
  namespace: string;
  key: string;
  value: unknown;
  /** Searchable text summary used by retrieveMemory(). */
  text: string;
  createdAt: number;
  updatedAt: number;
}

export type EventStatus = "pending" | "delivered" | "handled" | "rejected" | "failed";

export interface AgentEvent {
  id: string;
  sourceAgent: AgentId;
  targetAgent: AgentId;
  type: string;
  userId: string;
  /** Actor who authorized the originating action. */
  authorizedBy: string;
  payload: Record<string, unknown>;
  timestamp: number;
  correlationId: string;
  status: EventStatus;
  statusReason?: string;
  resultTaskId?: string;
}

export interface ScheduledJob {
  id: string;
  agentId: AgentId;
  userId: string;
  kind: string;
  runAt: number;
  /** Repeat interval in ms; absent for one-shot jobs. */
  everyMs?: number;
  payload: Record<string, unknown>;
  status: "scheduled" | "running" | "done" | "failed" | "cancelled";
  lastRunAt?: number;
  lastError?: string;
}

/** Cross-agent consent: user-enabled permission for one source→target event type. */
export interface ConsentGrant {
  userId: string;
  sourceAgent: AgentId;
  targetAgent: AgentId;
  eventType: string;
  enabled: boolean;
  grantedBy: string;
  updatedAt: number;
}

/** Shared household/preference data that agents may read only with explicit permission. */
export type SharedDataKey =
  | "profile"
  | "household"
  | "trustedContacts"
  | "dietaryPreferences"
  | "accessibility"
  | "paymentPreferences";

export interface SharedAccessGrant {
  userId: string;
  agentId: AgentId;
  key: SharedDataKey;
  enabled: boolean;
}

/**
 * Fine-grained caregiver scopes. Agent-level flags below stay as they were; an agent with sensitive
 * data (Care) additionally requires the matching scope on the backend. View and approve are separate.
 */
export type CaregiverScope =
  | "care:medications"
  | "care:medications:approve"
  | "care:grocery"
  | "care:grocery:approve"
  /** View-only: the person's home-repair bookings. Caregivers can never approve, change or decline them. */
  | "care:home-services";

/** Caregiver permissions, configured by the older adult. */
export interface CaregiverPermission {
  userId: string;
  caregiverId: string;
  agentId: AgentId;
  canViewSummaries: boolean;
  canApprove: boolean;
  /** Optional fine-grained scopes (see CaregiverScope). Absent = no scoped access. */
  scopes?: CaregiverScope[];
  /** When the owner granted it (set by the store). */
  grantedAt?: number;
  /** Revoked grants are kept as an audit trail but give no access. */
  revokedAt?: number;
  /** Optional end of access (ms). Expired grants give no access. */
  expiresAt?: number;
  /** How the caregiver sees this person in their list (chosen by the person; no identifiers). */
  recipientLabel?: string;
}
