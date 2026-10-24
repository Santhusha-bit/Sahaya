import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const toEvent = (doc: any) => ({
  id: doc.rid,
  correlationId: doc.correlationId,
  sourceAgent: doc.sourceAgent,
  targetAgent: doc.targetAgent,
  type: doc.type,
  userId: doc.userId,
  payload: doc.payload,
  status: doc.status,
  reason: doc.reason,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const put = mutation({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    const row = {
      rid: event.id,
      correlationId: event.correlationId,
      sourceAgent: event.sourceAgent,
      targetAgent: event.targetAgent,
      type: event.type,
      userId: event.userId,
      payload: event.payload,
      status: event.status,
      reason: event.reason,
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    };
    const existing = await ctx.db.query("events").withIndex("by_rid", (q) => q.eq("rid", event.id)).unique();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("events", row);
    return event;
  },
});

export const list = query({
  args: {
    userId: v.string(),
    targetAgent: v.optional(v.string()),
    sourceAgent: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db.query("events").withIndex("by_user", (q) => q.eq("userId", args.userId)).collect();
    if (args.targetAgent) rows = rows.filter((r) => r.targetAgent === args.targetAgent);
    if (args.sourceAgent) rows = rows.filter((r) => r.sourceAgent === args.sourceAgent);
    if (args.correlationId) rows = rows.filter((r) => r.correlationId === args.correlationId);
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) rows = rows.slice(0, args.limit);
    return rows.map(toEvent);
  },
});

export const patch = mutation({
  args: { id: v.string(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const doc = await ctx.db.query("events").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    if (!doc) return null;
    await ctx.db.patch(doc._id, patch);
    return toEvent({ ...doc, ...patch });
  },
});
