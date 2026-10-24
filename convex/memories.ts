import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const toRecord = (doc: any) => ({
  id: doc.rid,
  namespace: doc.namespace,
  collection: doc.collection,
  userId: doc.userId,
  data: doc.data,
  tags: doc.tags,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const put = mutation({
  args: { record: v.any() },
  handler: async (ctx, { record }) => {
    const row = {
      rid: record.id,
      namespace: record.namespace,
      collection: record.collection,
      userId: record.userId,
      data: record.data,
      tags: record.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const existing = await ctx.db.query("memories").withIndex("by_rid", (q) => q.eq("rid", record.id)).unique();
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("memories", row);
    return record;
  },
});

export const get = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.query("memories").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    return doc ? toRecord(doc) : null;
  },
});

export const list = query({
  args: {
    namespace: v.string(),
    userId: v.string(),
    collection: v.optional(v.string()),
    tag: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db
      .query("memories")
      .withIndex("by_scope", (q) => {
        const base = q.eq("userId", args.userId).eq("namespace", args.namespace);
        return args.collection ? base.eq("collection", args.collection) : base;
      })
      .collect();
    if (args.tag) rows = rows.filter((r) => r.tags?.includes(args.tag!));
    rows.sort((a, b) => b.createdAt - a.createdAt);
    if (args.limit) rows = rows.slice(0, args.limit);
    return rows.map(toRecord);
  },
});

export const patch = mutation({
  args: { id: v.string(), data: v.any() },
  handler: async (ctx, { id, data }) => {
    const doc = await ctx.db.query("memories").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    if (!doc) return null;
    const merged = { ...doc.data, ...data };
    await ctx.db.patch(doc._id, { data: merged, updatedAt: Date.now() });
    return toRecord({ ...doc, data: merged, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.query("memories").withIndex("by_rid", (q) => q.eq("rid", id)).unique();
    if (!doc) return false;
    await ctx.db.delete(doc._id);
    return true;
  },
});
