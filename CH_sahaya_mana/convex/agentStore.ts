/**
 * Convex implementation of the AgentStore operations used by the Sahaya runtime (see src/lib/storage/ConvexStore.ts).
 *
 * Security model:
 *  - The caller is ONLY `ctx.auth.getUserIdentity()` (Auth0 ID token verified by Convex — see auth.config.ts).
 *    Its id is `${issuer}|${subject}`, the same string the app derives from the verified session.
 *  - Every `userId` argument is checked against the caller (the person, or their own demo profile `…#demo`);
 *    it is never trusted as identity. Rows of other users are invisible (reads return null/empty, writes throw).
 *  - Caregivers: access to another person's Care data requires that person's active (not revoked, not expired)
 *    grant naming the caller, and is limited to the granted capabilities (src/agents/care/accessRules.ts):
 *    view scopes allow reading rows of that area; approve scopes allow deciding and carrying out actions of that
 *    area. Conversations, learned profile details and other agents are never reachable. Grants are created and
 *    revoked only by the person.
 *  - Approval decisions and consumption are single-transaction compare-and-set mutations using server time.
 *  - Writes are idempotent upserts keyed by the record id, so a retried request can't duplicate data.
 * No function logs arguments or values.
 */
import { mutationGeneric, queryGeneric, type DataModelFromSchemaDefinition, type GenericMutationCtx, type GenericQueryCtx, type MutationBuilder, type QueryBuilder } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { buildRedactor, redactDeep } from "../src/agents/base/redact";
import { anyApprove, canApprove, canView, caregiverMayRead, caregiverMayWrite, grantActive, grantLive, TOOL_AREA, type GrantLike } from "../src/agents/care/accessRules";
import schema from "./schema";

type DM = DataModelFromSchemaDefinition<typeof schema>;
const query = queryGeneric as unknown as QueryBuilder<DM, "public">;
const mutation = mutationGeneric as unknown as MutationBuilder<DM, "public">;
type QCtx = GenericQueryCtx<DM>;
type MCtx = GenericMutationCtx<DM>;

// ── Validators (mirror src/agents/base/types.ts) ─────────────────────────────
const agentId = v.union(v.literal("guardian"), v.literal("care"), v.literal("wellness"), v.literal("finance"));
const approvalStatus = v.union(v.literal("pending"), v.literal("approved"), v.literal("denied"), v.literal("consumed"), v.literal("expired"));
const scope = v.union(v.literal("care:medications"), v.literal("care:medications:approve"), v.literal("care:grocery"), v.literal("care:grocery:approve"), v.literal("care:home-services"));
const id = v.string();

const messageV = v.object({
  id,
  agentId,
  userId: v.string(),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.any(),
  text: v.string(),
  channel: v.union(v.literal("text"), v.literal("voice"), v.literal("system")),
  at: v.number(),
});
const memoryV = v.object({ id, agentId, userId: v.string(), namespace: v.string(), key: v.string(), value: v.any(), text: v.string(), createdAt: v.number(), updatedAt: v.number() });
const taskV = v.object({
  id,
  agentId,
  userId: v.string(),
  title: v.string(),
  status: v.union(v.literal("planned"), v.literal("running"), v.literal("awaiting_approval"), v.literal("completed"), v.literal("failed"), v.literal("cancelled")),
  steps: v.array(v.any()),
  origin: v.union(v.literal("conversation"), v.literal("workflow"), v.literal("event"), v.literal("schedule")),
  workflowId: v.optional(v.string()),
  correlationId: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  result: v.optional(v.any()),
  error: v.optional(v.string()),
});
const approvalV = v.object({
  id,
  agentId,
  userId: v.string(),
  taskId: v.optional(v.string()),
  stepId: v.optional(v.string()),
  toolName: v.string(),
  input: v.any(),
  inputHash: v.string(),
  summary: v.string(),
  status: approvalStatus,
  requestedBy: v.string(),
  createdAt: v.number(),
  expiresAt: v.number(),
  decidedAt: v.optional(v.number()),
  decidedBy: v.optional(v.string()),
});
const logV = v.object({
  id,
  agentId,
  userId: v.string(),
  kind: v.string(),
  level: v.union(v.literal("info"), v.literal("warn"), v.literal("error")),
  message: v.string(),
  data: v.optional(v.any()),
  correlationId: v.optional(v.string()),
  at: v.number(),
});
const eventV = v.object({
  id,
  sourceAgent: agentId,
  targetAgent: agentId,
  type: v.string(),
  userId: v.string(),
  authorizedBy: v.string(),
  payload: v.any(),
  timestamp: v.number(),
  correlationId: v.string(),
  status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("handled"), v.literal("rejected"), v.literal("failed")),
  statusReason: v.optional(v.string()),
  resultTaskId: v.optional(v.string()),
});
const jobV = v.object({
  id,
  agentId,
  userId: v.string(),
  kind: v.string(),
  runAt: v.number(),
  everyMs: v.optional(v.number()),
  payload: v.any(),
  status: v.union(v.literal("scheduled"), v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("cancelled")),
  lastRunAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
});
const consentV = v.object({ userId: v.string(), sourceAgent: agentId, targetAgent: agentId, eventType: v.string(), enabled: v.boolean(), grantedBy: v.string(), updatedAt: v.number() });
const sharedAccessV = v.object({ userId: v.string(), agentId, key: v.string(), enabled: v.boolean() });
const caregiverV = v.object({
  userId: v.string(),
  caregiverId: v.string(),
  agentId,
  canViewSummaries: v.boolean(),
  canApprove: v.boolean(),
  scopes: v.optional(v.array(scope)),
  grantedAt: v.optional(v.number()),
  revokedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  recipientLabel: v.optional(v.string()),
});

// ── Identity & ownership ──────────────────────────────────────────────────────
function fail(code: "UNAUTHENTICATED" | "FORBIDDEN" | "VALIDATION" | "NOT_FOUND"): never {
  throw new ConvexError({ code });
}

/** The verified caller. Never derived from arguments. */
export async function callerId(ctx: { auth: QCtx["auth"] }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || !identity.subject || !identity.issuer) fail("UNAUTHENTICATED");
  return `${identity.issuer}|${identity.subject}`;
}

/** A user id the caller may act on: themselves or their own fictional demo profile. */
function mayActOn(caller: string, userId: string) {
  return userId === caller || userId === `${caller}#demo`;
}

async function owner(ctx: { auth: QCtx["auth"] }, userId: string) {
  const caller = await callerId(ctx);
  if (!mayActOn(caller, userId)) fail("FORBIDDEN");
  return caller;
}

type Access = { caller: string; owner: true; grant?: undefined } | { caller: string; owner: false; grant: GrantLike };

/** Owner (or their demo profile), or a caregiver holding an active grant from this person for the agent. */
async function access(ctx: QCtx | MCtx, userId: string, agent: string): Promise<Access> {
  const caller = await callerId(ctx);
  if (mayActOn(caller, userId)) return { caller, owner: true };
  if (agent !== "care") fail("FORBIDDEN");
  const row = await ctx.db
    .query("caregiverPermissions")
    .withIndex("by_user_caregiver_agent", (q) => q.eq("userId", userId).eq("caregiverId", caller).eq("agentId", "care"))
    .unique();
  if (!row || !grantActive(row, Date.now())) fail("FORBIDDEN");
  return { caller, owner: false, grant: row };
}

/** The caller's active grant from this person for Care, or null (never throws). */
async function activeGrant(ctx: QCtx | MCtx, userId: string, caller: string): Promise<GrantLike | null> {
  const row = await ctx.db
    .query("caregiverPermissions")
    .withIndex("by_user_caregiver_agent", (q) => q.eq("userId", userId).eq("caregiverId", caller).eq("agentId", "care"))
    .unique();
  return row && grantActive(row, Date.now()) ? row : null;
}

function toolArea(toolName: string) {
  return TOOL_AREA[toolName];
}

function strip<T extends { _id: unknown; _creationTime: number; externalId?: string }>(doc: T) {
  const { _id, _creationTime, externalId, ...rest } = doc;
  void _id;
  void _creationTime;
  return externalId === undefined ? rest : { id: externalId, ...rest };
}

const MAX_TEXT = 20_000;
function checkSize(value: unknown, max = 200_000) {
  if (JSON.stringify(value ?? null).length > max) fail("VALIDATION");
}

// ── Conversation ──────────────────────────────────────────────────────────────
export const appendMessage = mutation({
  args: { msg: messageV },
  handler: async (ctx: MCtx, { msg }) => {
    await owner(ctx, msg.userId);
    if (msg.text.length > MAX_TEXT) fail("VALIDATION");
    checkSize(msg.content);
    const { id: externalId, ...rest } = msg;
    const existing = await ctx.db.query("messages").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
    if (existing) {
      if (existing.userId !== msg.userId || existing.agentId !== msg.agentId) fail("FORBIDDEN");
      await ctx.db.replace(existing._id, { externalId, ...rest });
      return null;
    }
    await ctx.db.insert("messages", { externalId, ...rest });
    return null;
  },
});

export const listMessages = query({
  args: { agentId, userId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx: QCtx, { agentId, userId, limit }) => {
    await owner(ctx, userId);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_agent_user_at", (q) => q.eq("agentId", agentId).eq("userId", userId))
      .order("desc")
      .take(Math.min(Math.max(limit ?? 200, 1), 500));
    return rows.reverse().map(strip);
  },
});

export const redactConversation = mutation({
  args: { agentId, userId: v.string(), terms: v.array(v.string()), replacement: v.optional(v.string()) },
  handler: async (ctx: MCtx, { agentId, userId, terms, replacement }) => {
    await owner(ctx, userId);
    if (terms.length > 20 || terms.some((t) => t.length > 200)) fail("VALIDATION");
    const redact = buildRedactor(terms, replacement ?? "[forgotten]");
    if (!redact) return 0;
    let changed = 0;
    for await (const m of ctx.db.query("messages").withIndex("by_agent_user_at", (q) => q.eq("agentId", agentId).eq("userId", userId))) {
      const [content, c1] = redactDeep(m.content, redact);
      const text = redact(m.text);
      if (c1 || text !== m.text) {
        await ctx.db.patch(m._id, { content, text });
        changed++;
      }
    }
    for await (const t of ctx.db.query("tasks").withIndex("by_user_agent_updated", (q) => q.eq("userId", userId).eq("agentId", agentId))) {
      const title = redact(t.title);
      const [steps, c1] = redactDeep(t.steps, redact);
      const [result, c2] = redactDeep(t.result, redact);
      const error = t.error === undefined ? undefined : redact(t.error);
      if (title !== t.title || c1 || c2 || error !== t.error) {
        await ctx.db.patch(t._id, { title, steps: steps as unknown[], result, error });
        changed++;
      }
    }
    return changed;
  },
});

// ── Memory ───────────────────────────────────────────────────────────────────
async function memoryRow(ctx: QCtx | MCtx, agent: Infer<typeof agentId>, userId: string, namespace: string, key: string) {
  return ctx.db
    .query("memory")
    .withIndex("by_agent_user_ns_key", (q) => q.eq("agentId", agent).eq("userId", userId).eq("namespace", namespace).eq("key", key))
    .unique();
}

export const putMemory = mutation({
  args: { rec: memoryV },
  handler: async (ctx: MCtx, { rec }) => {
    const a = await access(ctx, rec.userId, rec.agentId);
    checkSize(rec.value);
    const { id: externalId, ...rest } = rec;
    const existing = await memoryRow(ctx, rec.agentId, rec.userId, rec.namespace, rec.key);
    if (!a.owner && (!caregiverMayWrite(a.grant, rec.namespace, rec.value) || (existing && !caregiverMayWrite(a.grant, rec.namespace, existing.value)))) fail("FORBIDDEN");
    if (existing) await ctx.db.replace(existing._id, { externalId, ...rest });
    else await ctx.db.insert("memory", { externalId, ...rest });
    return null;
  },
});

export const getMemory = query({
  args: { agentId, userId: v.string(), namespace: v.string(), key: v.string() },
  handler: async (ctx: QCtx, a) => {
    const who = await access(ctx, a.userId, a.agentId);
    const row = await memoryRow(ctx, a.agentId, a.userId, a.namespace, a.key);
    if (!row || (!who.owner && !caregiverMayRead(who.grant, a.namespace, row.value))) return null;
    return strip(row);
  },
});

export const listMemory = query({
  args: { agentId, userId: v.string(), namespace: v.optional(v.string()) },
  handler: async (ctx: QCtx, a) => {
    const who = await access(ctx, a.userId, a.agentId);
    if (!who.owner && a.namespace === undefined) fail("FORBIDDEN");
    const rows = await ctx.db
      .query("memory")
      .withIndex("by_agent_user_ns_key", (q) => {
        const base = q.eq("agentId", a.agentId).eq("userId", a.userId);
        return a.namespace === undefined ? base : base.eq("namespace", a.namespace);
      })
      .collect();
    return rows.filter((r) => who.owner || caregiverMayRead(who.grant, r.namespace, r.value)).map(strip);
  },
});

export const deleteMemory = mutation({
  args: { agentId, userId: v.string(), namespace: v.string(), key: v.string() },
  handler: async (ctx: MCtx, a) => {
    const who = await access(ctx, a.userId, a.agentId);
    const row = await memoryRow(ctx, a.agentId, a.userId, a.namespace, a.key);
    if (row && !who.owner && !caregiverMayWrite(who.grant, a.namespace, row.value)) fail("FORBIDDEN");
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

// ── Tasks ────────────────────────────────────────────────────────────────────
export const saveTask = mutation({
  args: { task: taskV },
  handler: async (ctx: MCtx, { task }) => {
    const who = await access(ctx, task.userId, task.agentId);
    if (!who.owner && !anyApprove(who.grant)) fail("FORBIDDEN");
    checkSize(task);
    const { id: externalId, ...rest } = task;
    const existing = await ctx.db.query("tasks").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
    if (existing) {
      if (existing.userId !== task.userId || existing.agentId !== task.agentId) fail("FORBIDDEN");
      await ctx.db.replace(existing._id, { externalId, ...rest });
    } else await ctx.db.insert("tasks", { externalId, ...rest });
    return null;
  },
});

export const getTask = query({
  args: { id },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    const row = await ctx.db.query("tasks").withIndex("by_external", (q) => q.eq("externalId", a.id)).unique();
    if (!row) return null;
    if (mayActOn(caller, row.userId)) return strip(row);
    const g = await activeGrant(ctx, row.userId, caller);
    return g && row.agentId === "care" && anyApprove(g) ? strip(row) : null;
  },
});

export const listTasks = query({
  args: { userId: v.string(), agentId: v.optional(agentId), status: v.optional(v.array(v.string())), limit: v.optional(v.number()) },
  handler: async (ctx: QCtx, f) => {
    await owner(ctx, f.userId);
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_user_agent_updated", (q) => (f.agentId ? q.eq("userId", f.userId).eq("agentId", f.agentId) : q.eq("userId", f.userId)))
      .order("desc")
      .collect();
    return rows.filter((t) => !f.status || f.status.includes(t.status)).slice(0, f.limit ?? 100).map(strip);
  },
});

// ── Approvals ────────────────────────────────────────────────────────────────
async function approvalRow(ctx: QCtx | MCtx, externalId: string) {
  return ctx.db.query("approvals").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
}

/**
 * Create a pending approval, or update one without granting it: status may only move to "expired" here,
 * and inputs/summaries may only be minimized once an approval is no longer usable. Deciding goes through
 * transitionApproval; consuming through consumeApproval.
 */
export const saveApproval = mutation({
  args: { approval: approvalV },
  handler: async (ctx: MCtx, { approval }) => {
    const who = await access(ctx, approval.userId, approval.agentId);
    if (!who.owner) {
      const rule = toolArea(approval.toolName);
      if (!rule || rule.userOnly || !canApprove(who.grant, rule.area)) fail("FORBIDDEN");
    }
    checkSize(approval);
    const { id: externalId, ...rest } = approval;
    const existing = await approvalRow(ctx, externalId);
    if (!existing) {
      if (rest.status !== "pending") fail("FORBIDDEN");
      await ctx.db.insert("approvals", { externalId, ...rest });
      return null;
    }
    if (existing.userId !== approval.userId || existing.agentId !== approval.agentId || existing.toolName !== approval.toolName) fail("FORBIDDEN");
    const statusChange = rest.status !== existing.status;
    if (statusChange && rest.status !== "expired") fail("FORBIDDEN");
    const contentChange = rest.inputHash !== existing.inputHash || rest.summary !== existing.summary;
    if (contentChange && !["expired", "denied", "consumed"].includes(rest.status)) fail("FORBIDDEN");
    await ctx.db.patch(existing._id, {
      status: rest.status,
      summary: rest.summary,
      input: rest.input,
      inputHash: rest.inputHash,
    });
    return null;
  },
});

export const getApproval = query({
  args: { id },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    const row = await approvalRow(ctx, a.id);
    if (!row) return null;
    if (mayActOn(caller, row.userId)) return strip(row);
    const g = await activeGrant(ctx, row.userId, caller);
    const rule = toolArea(row.toolName);
    return g && rule && canView(g, rule.area) ? strip(row) : null;
  },
});

export const listApprovals = query({
  args: { userId: v.string(), agentId: v.optional(agentId), status: v.optional(v.array(approvalStatus)) },
  handler: async (ctx: QCtx, f) => {
    const who = await access(ctx, f.userId, f.agentId ?? "care");
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_user_agent_status", (q) => (f.agentId ? q.eq("userId", f.userId).eq("agentId", f.agentId) : q.eq("userId", f.userId)))
      .collect();
    return rows
      .filter((a) => !f.status || f.status.includes(a.status as Infer<typeof approvalStatus>))
      .filter((a) => {
        if (who.owner) return true;
        const rule = toolArea(a.toolName);
        return a.agentId === "care" && rule !== undefined && canView(who.grant, rule.area);
      })
      .sort((x, y) => y.createdAt - x.createdAt)
      .map(strip);
  },
});

/** The person, or a caregiver with the approve capability for this action's area (never for person-only actions). */
async function mayDecide(ctx: QCtx | MCtx, caller: string, row: { userId: string; toolName: string; agentId: string }) {
  if (mayActOn(caller, row.userId)) return true;
  const rule = toolArea(row.toolName);
  if (row.agentId !== "care" || !rule || rule.userOnly) return false;
  const g = await activeGrant(ctx, row.userId, caller);
  return Boolean(g && canApprove(g, rule.area));
}

/** Single transaction: owner, status, tool, input hash and expiry (server time) are checked together, then consumed. */
export const consumeApproval = mutation({
  args: { id, expect: v.optional(v.object({ userId: v.string(), toolName: v.string(), inputHash: v.string() })) },
  handler: async (ctx: MCtx, a) => {
    const caller = await callerId(ctx);
    const row = await approvalRow(ctx, a.id);
    if (!row || !(await mayDecide(ctx, caller, row)) || row.status !== "approved") return false;
    if (row.expiresAt < Date.now()) return false;
    if (a.expect && (a.expect.userId !== row.userId || a.expect.toolName !== row.toolName || a.expect.inputHash !== row.inputHash)) return false;
    await ctx.db.patch(row._id, { status: "consumed" });
    return true;
  },
});

/** Single transaction: pending → decided only if still pending (and unexpired when approving). decidedBy = caller. */
export const transitionApproval = mutation({
  args: { id, from: approvalStatus, to: approvalStatus },
  handler: async (ctx: MCtx, a) => {
    const caller = await callerId(ctx);
    const row = await approvalRow(ctx, a.id);
    if (!row || !(await mayDecide(ctx, caller, row)) || row.status !== a.from) return false;
    if (!["approved", "denied", "expired"].includes(a.to) || a.from !== "pending") fail("FORBIDDEN");
    const now = Date.now();
    if (a.to === "approved" && row.expiresAt < now) {
      await ctx.db.patch(row._id, { status: "expired" });
      return false;
    }
    await ctx.db.patch(row._id, { status: a.to, decidedAt: now, decidedBy: caller });
    return true;
  },
});

// ── Logs ─────────────────────────────────────────────────────────────────────
export const appendLog = mutation({
  args: { log: logV },
  handler: async (ctx: MCtx, { log }) => {
    // Caregivers acting under an active grant append to the person's Care log (append-only; no reads).
    await access(ctx, log.userId, log.agentId);
    checkSize(log, 20_000);
    const { id: externalId, ...rest } = log;
    const existing = await ctx.db.query("executionLogs").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
    if (existing) return null; // idempotent retry
    await ctx.db.insert("executionLogs", { externalId, ...rest });
    return null;
  },
});

export const listLogs = query({
  args: { userId: v.string(), agentId: v.optional(agentId), correlationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx: QCtx, f) => {
    await owner(ctx, f.userId);
    const rows = await ctx.db
      .query("executionLogs")
      .withIndex("by_user_agent_at", (q) => (f.agentId ? q.eq("userId", f.userId).eq("agentId", f.agentId) : q.eq("userId", f.userId)))
      .order("desc")
      .take(1000);
    return rows
      .filter((l) => !f.correlationId || l.correlationId === f.correlationId)
      .slice(0, f.limit ?? 200)
      .reverse()
      .map(strip);
  },
});

// ── Events ───────────────────────────────────────────────────────────────────
export const saveEvent = mutation({
  args: { event: eventV },
  handler: async (ctx: MCtx, { event }) => {
    await owner(ctx, event.userId);
    checkSize(event);
    const { id: externalId, ...rest } = event;
    const existing = await ctx.db.query("agentEvents").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
    if (existing) {
      if (existing.userId !== event.userId) fail("FORBIDDEN");
      await ctx.db.replace(existing._id, { externalId, ...rest });
    } else await ctx.db.insert("agentEvents", { externalId, ...rest });
    return null;
  },
});

export const getEvent = query({
  args: { id },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    const row = await ctx.db.query("agentEvents").withIndex("by_external", (q) => q.eq("externalId", a.id)).unique();
    return row && mayActOn(caller, row.userId) ? strip(row) : null;
  },
});

export const listEvents = query({
  args: { userId: v.string(), agentId: v.optional(agentId), correlationId: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx: QCtx, f) => {
    await owner(ctx, f.userId);
    const rows = await ctx.db.query("agentEvents").withIndex("by_user_time", (q) => q.eq("userId", f.userId)).order("desc").take(500);
    return rows
      .filter((e) => (!f.agentId || e.sourceAgent === f.agentId || e.targetAgent === f.agentId) && (!f.correlationId || e.correlationId === f.correlationId))
      .slice(0, f.limit ?? 100)
      .map(strip);
  },
});

// ── Scheduled jobs ───────────────────────────────────────────────────────────
export const saveJob = mutation({
  args: { job: jobV },
  handler: async (ctx: MCtx, { job }) => {
    const who = await access(ctx, job.userId, job.agentId);
    if (!who.owner && !anyApprove(who.grant)) fail("FORBIDDEN");
    const { id: externalId, ...rest } = job;
    const existing = await ctx.db.query("scheduledJobs").withIndex("by_external", (q) => q.eq("externalId", externalId)).unique();
    if (existing) {
      if (existing.userId !== job.userId) fail("FORBIDDEN");
      await ctx.db.replace(existing._id, { externalId, ...rest });
    } else await ctx.db.insert("scheduledJobs", { externalId, ...rest });
    return null;
  },
});

export const getJob = query({
  args: { id },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    const row = await ctx.db.query("scheduledJobs").withIndex("by_external", (q) => q.eq("externalId", a.id)).unique();
    if (!row) return null;
    if (mayActOn(caller, row.userId)) return strip(row);
    const g = await activeGrant(ctx, row.userId, caller);
    return g && row.agentId === "care" && anyApprove(g) ? strip(row) : null;
  },
});

export const listJobs = query({
  args: { userId: v.string(), agentId: v.optional(agentId) },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    const rows = await ctx.db
      .query("scheduledJobs")
      .withIndex("by_user_agent", (q) => (a.agentId ? q.eq("userId", a.userId).eq("agentId", a.agentId) : q.eq("userId", a.userId)))
      .collect();
    return rows.map(strip);
  },
});

/** Due jobs of the caller only (a deployment-wide scheduler would be an internal function, not public). */
export const listDueJobs = query({
  args: { now: v.number() },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    const out = [];
    for (const uid of [caller, `${caller}#demo`]) {
      const rows = await ctx.db.query("scheduledJobs").withIndex("by_user_agent", (q) => q.eq("userId", uid)).collect();
      out.push(...rows.filter((j) => j.status === "scheduled" && j.runAt <= a.now));
    }
    return out.map(strip);
  },
});

// ── Consent and shared data (owner only) ─────────────────────────────────────
export const getConsent = query({
  args: { userId: v.string(), sourceAgent: agentId, targetAgent: agentId, eventType: v.string() },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    const row = await ctx.db
      .query("consentGrants")
      .withIndex("by_route", (q) => q.eq("userId", a.userId).eq("sourceAgent", a.sourceAgent).eq("targetAgent", a.targetAgent).eq("eventType", a.eventType))
      .unique();
    return row ? strip(row) : null;
  },
});

export const setConsent = mutation({
  args: { grant: consentV },
  handler: async (ctx: MCtx, { grant }) => {
    const caller = await owner(ctx, grant.userId);
    const row = await ctx.db
      .query("consentGrants")
      .withIndex("by_route", (q) => q.eq("userId", grant.userId).eq("sourceAgent", grant.sourceAgent).eq("targetAgent", grant.targetAgent).eq("eventType", grant.eventType))
      .unique();
    const doc = { ...grant, grantedBy: caller, updatedAt: Date.now() };
    if (row) await ctx.db.replace(row._id, doc);
    else await ctx.db.insert("consentGrants", doc);
    return null;
  },
});

export const listConsents = query({
  args: { userId: v.string() },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    return (await ctx.db.query("consentGrants").withIndex("by_route", (q) => q.eq("userId", a.userId)).collect()).map(strip);
  },
});

export const getSharedAccess = query({
  args: { userId: v.string(), agentId, key: v.string() },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    const row = await ctx.db.query("sharedAccessGrants").withIndex("by_user_agent_key", (q) => q.eq("userId", a.userId).eq("agentId", a.agentId).eq("key", a.key)).unique();
    return row ? strip(row) : null;
  },
});

export const setSharedAccess = mutation({
  args: { grant: sharedAccessV },
  handler: async (ctx: MCtx, { grant }) => {
    await owner(ctx, grant.userId);
    const row = await ctx.db.query("sharedAccessGrants").withIndex("by_user_agent_key", (q) => q.eq("userId", grant.userId).eq("agentId", grant.agentId).eq("key", grant.key)).unique();
    if (row) await ctx.db.replace(row._id, grant);
    else await ctx.db.insert("sharedAccessGrants", grant);
    return null;
  },
});

export const getSharedData = query({
  args: { userId: v.string(), key: v.string() },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    const row = await ctx.db.query("sharedData").withIndex("by_user_key", (q) => q.eq("userId", a.userId).eq("key", a.key)).unique();
    return row ? row.value : null;
  },
});

export const setSharedData = mutation({
  args: { userId: v.string(), key: v.string(), value: v.any() },
  handler: async (ctx: MCtx, a) => {
    await owner(ctx, a.userId);
    checkSize(a.value);
    const row = await ctx.db.query("sharedData").withIndex("by_user_key", (q) => q.eq("userId", a.userId).eq("key", a.key)).unique();
    if (row) await ctx.db.patch(row._id, { value: a.value });
    else await ctx.db.insert("sharedData", { userId: a.userId, key: a.key, value: a.value });
    return null;
  },
});

// ── Caregiver grants ─────────────────────────────────────────────────────────
async function grantRow(ctx: QCtx | MCtx, userId: string, caregiverId: string, agent: Infer<typeof agentId>) {
  return ctx.db
    .query("caregiverPermissions")
    .withIndex("by_user_caregiver_agent", (q) => q.eq("userId", userId).eq("caregiverId", caregiverId).eq("agentId", agent))
    .unique();
}

/** The owner, or the caregiver themselves, may read a grant. Revoked/expired grants read as null. */
export const getCaregiverPermission = query({
  args: { userId: v.string(), caregiverId: v.string(), agentId },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    if (!mayActOn(caller, a.userId) && caller !== a.caregiverId) return null;
    const row = await grantRow(ctx, a.userId, a.caregiverId, a.agentId);
    if (!row || !grantLive(row, Date.now())) return null;
    return strip(row);
  },
});

/**
 * Only the person grants or revokes. Revoking = no flags/scopes; the row is kept with revokedAt as an audit trail.
 * An expiry must be in the future; the label is how the caregiver will see this person in their list.
 */
export const setCaregiverPermission = mutation({
  args: { perm: caregiverV },
  handler: async (ctx: MCtx, { perm }) => {
    const caller = await owner(ctx, perm.userId);
    if (perm.caregiverId === caller || perm.caregiverId === perm.userId || perm.caregiverId.includes("#")) fail("VALIDATION");
    if ((perm.recipientLabel?.length ?? 0) > 60) fail("VALIDATION");
    const now = Date.now();
    if (perm.expiresAt !== undefined && perm.expiresAt <= now) fail("VALIDATION");
    const revoked = !perm.canViewSummaries && !perm.canApprove && !(perm.scopes ?? []).length;
    const row = await grantRow(ctx, perm.userId, perm.caregiverId, perm.agentId);
    const doc = { ...perm, grantedAt: revoked ? row?.grantedAt : now, revokedAt: revoked ? now : undefined };
    if (row) await ctx.db.replace(row._id, doc);
    else if (!revoked) await ctx.db.insert("caregiverPermissions", doc);
    return null;
  },
});

/** Every grant this person has given (including revoked/expired, for their audit view). */
export const listGrantsForOwner = query({
  args: { userId: v.string() },
  handler: async (ctx: QCtx, a) => {
    await owner(ctx, a.userId);
    return (await ctx.db.query("caregiverPermissions").withIndex("by_user_caregiver_agent", (q) => q.eq("userId", a.userId)).collect()).map(strip);
  },
});

/** Active grants given to the caller. A caregiver can only ever choose among these recipients. */
export const listGrantsForCaregiver = query({
  args: { caregiverId: v.string() },
  handler: async (ctx: QCtx, a) => {
    const caller = await callerId(ctx);
    if (caller !== a.caregiverId) fail("FORBIDDEN");
    const now = Date.now();
    return (await ctx.db.query("caregiverPermissions").withIndex("by_caregiver", (q) => q.eq("caregiverId", caller)).collect())
      .filter((g) => grantActive(g, now))
      .map(strip);
  },
});
