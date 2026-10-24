import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const toMessage = (doc: any) => ({
  id: doc.rid,
  agentId: doc.agentId,
  userId: doc.userId,
  role: doc.role,
  content: doc.content,
  toolCalls: doc.toolCalls,
  createdAt: doc.createdAt,
});

export const append = mutation({
  args: { message: v.any() },
  handler: async (ctx, { message }) => {
    await ctx.db.insert("conversations", {
      rid: message.id,
      agentId: message.agentId,
      userId: message.userId,
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls,
      createdAt: message.createdAt,
    });
    return message;
  },
});

export const history = query({
  args: { userId: v.string(), agentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("conversations")
      .withIndex("by_agent", (q) => q.eq("userId", args.userId).eq("agentId", args.agentId))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    if (args.limit) rows = rows.slice(-args.limit);
    return rows.map(toMessage);
  },
});
