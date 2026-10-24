import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const toApproval = (doc: any) => ({
  id: doc.rid,
  agentId: doc.agentId,
  userId: doc.userId,
  toolName: doc.toolName,
  input: doc.input,
  title: doc.title,
  description: doc.description,
  status: doc.status,
  correlationId: doc.correlationId,
  createdAt: doc.createdAt,
  decidedAt: doc.decidedAt,
});

export const put = mutation({
  args: { approval: v.any() },
  handler: async (ctx, { approval }) => {
    const row = {
      rid: approval.id,
      agentId: approval.agentId,
      userId: approval.userId,
      toolName: approval.toolName,
      input: approval.input,
      title: approval.title,
      description: approval.description,
      status: approval.status,
      correlationId: approval.correlationId,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt,
    };
    const existing = await ctx.db.query("approvals").withIndex("by_rid", (q) => q.eq("rid", approval.id)).unique();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("approvals", row);
    return approval;
  },
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.query("approvals").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    return doc ? toApproval(doc) : null;
  },
});

export const list = query({
  args: { userId: v.string(), agentId: v.optional(v.string()), status: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("approvals")
      .withIndex("by_agent", (q) => {
        const base = q.eq("userId", args.userId);
        return args.agentId ? base.eq("agentId", args.agentId) : base;
      })
      .collect();
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) rows = rows.slice(0, args.limit);
    return rows.map(toApproval);
  },
});

export const patch = mutation({
  args: { id: v.string(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const doc = await ctx.db.query("approvals").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    if (!doc) return null;
    await ctx.db.patch(doc._id, patch);
    return toApproval({ ...doc, ...patch });
  },
});
