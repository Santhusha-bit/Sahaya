import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Persistence for the Sahaya agent runtime. Mirrors src/agents/base/AgentStore.
 * Every agent-owned table is keyed by (agentId, userId). The functions in ./agentStore.ts derive the caller from
 * ctx.auth (never from arguments) and only touch rows whose userId is the caller (or the caller's demo profile).
 */

const agentId = v.union(v.literal("guardian"), v.literal("care"), v.literal("wellness"), v.literal("finance"));

export default defineSchema({
  messages: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.any(),
    text: v.string(),
    channel: v.union(v.literal("text"), v.literal("voice"), v.literal("system")),
    at: v.number(),
  })
    .index("by_agent_user_at", ["agentId", "userId", "at"])
    .index("by_external", ["externalId"]),

  memory: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    namespace: v.string(),
    key: v.string(),
    value: v.any(),
    text: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_agent_user_ns_key", ["agentId", "userId", "namespace", "key"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["agentId", "userId", "namespace"] }),

  tasks: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    title: v.string(),
    status: v.string(),
    steps: v.array(v.any()),
    origin: v.string(),
    workflowId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  })
    .index("by_external", ["externalId"])
    .index("by_user_agent_updated", ["userId", "agentId", "updatedAt"]),

  approvals: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    taskId: v.optional(v.string()),
    stepId: v.optional(v.string()),
    toolName: v.string(),
    input: v.any(),
    inputHash: v.string(),
    summary: v.string(),
    status: v.string(),
    requestedBy: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    decidedAt: v.optional(v.number()),
    decidedBy: v.optional(v.string()),
  })
    .index("by_external", ["externalId"])
    .index("by_user_agent_status", ["userId", "agentId", "status"]),

  executionLogs: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    kind: v.string(),
    level: v.string(),
    message: v.string(),
    data: v.optional(v.any()),
    correlationId: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_user_agent_at", ["userId", "agentId", "at"])
    .index("by_external", ["externalId"])
    .index("by_correlation", ["correlationId"]),

  /** AgentEventBus: every cross-agent event attempt, accepted or rejected. */
  agentEvents: defineTable({
    externalId: v.string(),
    sourceAgent: agentId,
    targetAgent: agentId,
    type: v.string(),
    userId: v.string(),
    authorizedBy: v.string(),
    payload: v.any(),
    timestamp: v.number(),
    correlationId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("handled"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    statusReason: v.optional(v.string()),
    resultTaskId: v.optional(v.string()),
  })
    .index("by_external", ["externalId"])
    .index("by_user_time", ["userId", "timestamp"])
    .index("by_correlation", ["correlationId"]),

  scheduledJobs: defineTable({
    externalId: v.string(),
    agentId,
    userId: v.string(),
    kind: v.string(),
    runAt: v.number(),
    everyMs: v.optional(v.number()),
    payload: v.any(),
    status: v.string(),
    lastRunAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_external", ["externalId"])
    .index("by_status_runAt", ["status", "runAt"])
    .index("by_user_agent", ["userId", "agentId"]),

  consentGrants: defineTable({
    userId: v.string(),
    sourceAgent: agentId,
    targetAgent: agentId,
    eventType: v.string(),
    enabled: v.boolean(),
    grantedBy: v.string(),
    updatedAt: v.number(),
  }).index("by_route", ["userId", "sourceAgent", "targetAgent", "eventType"]),

  sharedAccessGrants: defineTable({
    userId: v.string(),
    agentId,
    key: v.string(),
    enabled: v.boolean(),
  }).index("by_user_agent_key", ["userId", "agentId", "key"]),

  sharedData: defineTable({
    userId: v.string(),
    key: v.string(),
    value: v.any(),
  }).index("by_user_key", ["userId", "key"]),

  caregiverPermissions: defineTable({
    userId: v.string(),
    caregiverId: v.string(),
    agentId,
    canViewSummaries: v.boolean(),
    canApprove: v.boolean(),
    /** Fine-grained scopes, e.g. "care:medications", "care:grocery:approve" (see CaregiverScope). */
    scopes: v.optional(v.array(v.string())),
    grantedAt: v.optional(v.number()),
    /** Revoked grants stay as an audit trail and give no access. */
    revokedAt: v.optional(v.number()),
    /** Optional end of access; expired grants give no access. */
    expiresAt: v.optional(v.number()),
    /** How the caregiver sees this person in their list (chosen by the person). */
    recipientLabel: v.optional(v.string()),
  })
    .index("by_user_caregiver_agent", ["userId", "caregiverId", "agentId"])
    .index("by_caregiver", ["caregiverId"]),
});
