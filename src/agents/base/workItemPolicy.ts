/**
 * Agent security policy for controlled, multi-agent work items.
 *
 * PURE and deterministic. Nothing in here is a prompt: these tables decide
 *   1. which agent is capable of executing which tool (and under which scope),
 *   2. which agent may delegate work to which other agent,
 *   3. how risky an action is (required reviewer role, number of distinct
 *      approvals, approval lifetime), and
 *   4. who a reviewer actually is (roles come from this directory, never from a
 *      string the caller supplies).
 *
 * A model, a tool caller, or an external tracker (Jira) can ask for anything;
 * these checks decide what is allowed.
 */

import type { AgentId } from "./types";
import { AGENT_IDS } from "./types";

/* ------------------------------------------------------------------ */
/* 1. Agent capabilities: who can EXECUTE what                         */
/* ------------------------------------------------------------------ */

export interface Capability {
  toolName: string;
  scope: string;
}

export const AGENT_CAPABILITIES: Record<AgentId, Capability[]> = {
  finance: [
    { toolName: "executePayment", scope: "finance:payment" },
    { toolName: "freezeCard", scope: "finance:card" },
    { toolName: "fileBillingDispute", scope: "finance:dispute" },
    { toolName: "requestFinancialApproval", scope: "finance:commit-money" },
  ],
  care: [{ toolName: "requestOrderApproval", scope: "care:order" }],
  guardian: [],
  wellness: [],
};

/* ------------------------------------------------------------------ */
/* 2. Delegation: who can ASSIGN work to whom                          */
/* ------------------------------------------------------------------ */

/** requester -> assignee -> scopes the requester may hand to that assignee. */
export const DELEGATION_RULES: Partial<Record<AgentId, Partial<Record<AgentId, string[]>>>> = {
  guardian: { finance: ["finance:payment", "finance:card", "finance:dispute"] },
  care: { finance: ["finance:payment"], care: ["care:order"] },
  finance: { finance: ["finance:payment", "finance:card", "finance:dispute", "finance:commit-money"] },
  // wellness may not delegate any sensitive action.
};

export type PolicyCode =
  | "unknown_agent"
  | "not_capable"
  | "scope_mismatch"
  | "delegation_denied";

export interface PolicyDecision {
  ok: boolean;
  code?: PolicyCode;
  reason?: string;
}

export function authorizeDelegation(req: {
  requestingAgent: string;
  assignedAgent: string;
  toolName: string;
  permissionScope: string;
}): PolicyDecision {
  const ids = AGENT_IDS as string[];
  if (!ids.includes(req.requestingAgent) || !ids.includes(req.assignedAgent))
    return { ok: false, code: "unknown_agent", reason: "Unknown requesting or assigned agent." };

  const cap = AGENT_CAPABILITIES[req.assignedAgent as AgentId].find((c) => c.toolName === req.toolName);
  if (!cap)
    return {
      ok: false,
      code: "not_capable",
      reason: `Agent "${req.assignedAgent}" has no capability to run "${req.toolName}".`,
    };
  if (cap.scope !== req.permissionScope)
    return {
      ok: false,
      code: "scope_mismatch",
      reason: `"${req.toolName}" requires scope "${cap.scope}", not "${req.permissionScope}".`,
    };

  const allowed = DELEGATION_RULES[req.requestingAgent as AgentId]?.[req.assignedAgent as AgentId] ?? [];
  if (!allowed.includes(cap.scope))
    return {
      ok: false,
      code: "delegation_denied",
      reason: `Agent "${req.requestingAgent}" may not delegate "${cap.scope}" to "${req.assignedAgent}".`,
    };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 3. Risk tiers                                                        */
/* ------------------------------------------------------------------ */

export interface RiskRequirement {
  tier: "standard" | "high";
  requiredRole: string;
  requiredApprovals: number;
  approvalTtlMs: number;
}

/** Payments at or above this amount need two distinct caregivers (dual control). */
export const DUAL_CONTROL_THRESHOLD_USD = 1000;

export function riskRequirement(toolName: string, input: unknown): RiskRequirement {
  const amount = typeof (input as { amount?: unknown })?.amount === "number" ? (input as { amount: number }).amount : 0;
  const moneyMoving = toolName === "executePayment" || toolName === "requestFinancialApproval";
  if (moneyMoving && amount >= DUAL_CONTROL_THRESHOLD_USD) {
    return { tier: "high", requiredRole: "caregiver", requiredApprovals: 2, approvalTtlMs: 15 * 60_000 };
  }
  return { tier: "standard", requiredRole: "caregiver", requiredApprovals: 1, approvalTtlMs: 15 * 60_000 };
}

/* ------------------------------------------------------------------ */
/* 4. Reviewer directory                                                */
/* ------------------------------------------------------------------ */

export interface ReviewerPrincipal {
  id: string;
  name: string;
  /** The household (elder's userId) this person may review for. */
  householdUserId: string;
  roles: string[];
  /** Jira Cloud accountId, so a decision made in Jira can be attributed. */
  jiraAccountId?: string;
}

export class ReviewerDirectory {
  private readonly byId = new Map<string, ReviewerPrincipal>();

  constructor(principals: ReviewerPrincipal[]) {
    for (const p of principals) this.byId.set(`${p.householdUserId}:${p.id}`, p);
  }

  get(householdUserId: string, reviewerId: string): ReviewerPrincipal | null {
    return this.byId.get(`${householdUserId}:${reviewerId}`) ?? null;
  }

  byJiraAccount(householdUserId: string, accountId: string): ReviewerPrincipal | null {
    for (const p of this.byId.values())
      if (p.householdUserId === householdUserId && p.jiraAccountId && p.jiraAccountId === accountId) return p;
    return null;
  }

  list(householdUserId: string): ReviewerPrincipal[] {
    return [...this.byId.values()].filter((p) => p.householdUserId === householdUserId);
  }

  /** Adds the demo family for a household if it has none yet (sandbox identities). */
  ensureDemoHousehold(householdUserId: string): void {
    if (this.list(householdUserId).length) return;
    for (const p of demoFamily(householdUserId)) this.byId.set(`${householdUserId}:${p.id}`, p);
  }
}

/**
 * Sandbox demo family. Jira account ids can be bound with
 * ATLASSIAN_REVIEWER_ACCOUNTS="sarah=<accountId>,david=<accountId>" so a
 * transition made by that Jira user is attributed to that reviewer.
 */
export function demoFamily(householdUserId: string): ReviewerPrincipal[] {
  const accounts = parseAccountMap(process.env.ATLASSIAN_REVIEWER_ACCOUNTS);
  return [
    { id: "sarah", name: "Sarah (daughter)", householdUserId, roles: ["caregiver"], jiraAccountId: accounts.sarah },
    { id: "david", name: "David (son)", householdUserId, roles: ["caregiver"], jiraAccountId: accounts.david },
    { id: "neighbor", name: "Pat (neighbor)", householdUserId, roles: ["neighbor"], jiraAccountId: accounts.neighbor },
  ];
}

function parseAccountMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}
