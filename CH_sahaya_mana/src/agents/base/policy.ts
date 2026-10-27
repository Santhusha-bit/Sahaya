import type { AgentStore } from "./AgentStore";
import { AgentError } from "./errors";
import type { ActorRole, AgentContext, AgentId } from "./types";

/** Per-agent authorization and safety policy. Each agent configures its own. */
export interface AgentPolicy {
  /** Roles allowed to converse with the agent directly. */
  conversationRoles: ActorRole[];
  /** Whether a caregiver with `canApprove` for this agent may decide approvals. */
  caregiverMayApprove: boolean;
  /** How long a pending approval stays valid. */
  approvalTtlMs: number;
  /** Max model↔tool round trips per user turn. */
  maxToolIterations: number;
}

export const DEFAULT_POLICY: AgentPolicy = {
  conversationRoles: ["older_adult"],
  caregiverMayApprove: true,
  approvalTtlMs: 24 * 60 * 60 * 1000,
  maxToolIterations: 8,
};

export function assertCanConverse(ctx: AgentContext, agentId: AgentId, policy: AgentPolicy) {
  if (!policy.conversationRoles.includes(ctx.actor.role)) {
    throw new AgentError("PERMISSION_DENIED", `${ctx.actor.role} may not converse with the ${agentId} agent`);
  }
  if (ctx.actor.role === "older_adult" && ctx.actor.id !== ctx.userId) {
    throw new AgentError("PERMISSION_DENIED", "users may only converse with their own agents");
  }
}

export async function assertCanApprove(
  ctx: AgentContext,
  agentId: AgentId,
  policy: AgentPolicy,
  store: Pick<AgentStore, "getCaregiverPermission">,
) {
  if (ctx.actor.role === "older_adult" && ctx.actor.id === ctx.userId) return;
  if (ctx.actor.role === "caregiver" && policy.caregiverMayApprove) {
    const perm = await store.getCaregiverPermission(ctx.userId, ctx.actor.id, agentId);
    if (perm?.canApprove && !perm.revokedAt && (perm.expiresAt === undefined || perm.expiresAt > Date.now())) return;
  }
  throw new AgentError("PERMISSION_DENIED", `${ctx.actor.role} ${ctx.actor.id} may not approve ${agentId} actions`);
}

export async function canCaregiverView(store: AgentStore, userId: string, caregiverId: string, agentId: AgentId) {
  const perm = await store.getCaregiverPermission(userId, caregiverId, agentId);
  return Boolean(perm?.canViewSummaries);
}
