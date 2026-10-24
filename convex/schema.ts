import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex schema for Kinline. Each table stores the runtime record shape used by
 * the DataLayer. Agent isolation is preserved by always querying on
 * (userId, namespace) for memory and (userId, targetAgent) for events.
 */
export default defineSchema({
  memories: defineTable({
    rid: v.string(),
    namespace: v.string(),
    collection: v.string(),
    userId: v.string(),
    data: v.any(),
    tags: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_rid", ["rid"])
    .index("by_scope", ["userId", "namespace", "collection"]),

  events: defineTable({
    rid: v.string(),
    correlationId: v.string(),
    sourceAgent: v.string(),
    targetAgent: v.string(),
    type: v.string(),
    userId: v.string(),
    payload: v.any(),
    status: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_rid", ["rid"])
    .index("by_user", ["userId"])
    .index("by_target", ["userId", "targetAgent"]),

  tasks: defineTable({
    rid: v.string(),
    agentId: v.string(),
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
    steps: v.any(),
    correlationId: v.optional(v.string()),
    result: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_rid", ["rid"])
    .index("by_agent", ["userId", "agentId"]),

  approvals: defineTable({
    rid: v.string(),
    agentId: v.string(),
    userId: v.string(),
    toolName: v.string(),
    input: v.any(),
    title: v.string(),
    description: v.string(),
    status: v.string(),
    correlationId: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_rid", ["rid"])
    .index("by_agent", ["userId", "agentId"]),

  conversations: defineTable({
    rid: v.string(),
    agentId: v.string(),
    userId: v.string(),
    role: v.string(),
    content: v.string(),
    toolCalls: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_agent", ["userId", "agentId"]),
});
