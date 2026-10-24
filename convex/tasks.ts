import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const toTask = (doc: any) => ({
  id: doc.rid,
  agentId: doc.agentId,
  userId: doc.userId,
  title: doc.title,
  description: doc.description,
  status: doc.status,
  steps: doc.steps,
  correlationId: doc.correlationId,
  result: doc.result,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const put = mutation({
  args: { task: v.any() },
  handler: async (ctx, { task }) => {
    const row = {
      rid: task.id,
      agentId: task.agentId,
      userId: task.userId,
      title: task.title,
      description: task.description,
      status: task.status,
      steps: task.steps,
      correlationId: task.correlationId,
      result: task.result,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const existing = await ctx.db.query("tasks").withIndex("by_rid", (q) => q.eq("rid", task.id)).unique();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("tasks", row);
    return task;
  },
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.query("tasks").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    return doc ? toTask(doc) : null;
  },
});

export const list = query({
  args: { userId: v.string(), agentId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("tasks")
      .withIndex("by_agent", (q) => {
        const base = q.eq("userId", args.userId);
        return args.agentId ? base.eq("agentId", args.agentId) : base;
      })
      .collect();
    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    if (args.limit) rows = rows.slice(0, args.limit);
    return rows.map(toTask);
  },
});

export const patch = mutation({
  args: { id: v.string(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const doc = await ctx.db.query("tasks").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    if (!doc) return null;
    await ctx.db.patch(doc._id, patch);
    return toTask({ ...doc, ...patch });
  },
});
