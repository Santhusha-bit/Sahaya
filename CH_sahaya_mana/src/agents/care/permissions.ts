import type { AgentStore } from "../base/AgentStore";
import { AgentError } from "../base/errors";
import type { AgentContext, CaregiverScope } from "../base/types";
import { grantActive } from "./accessRules";

export type CareArea = "medications" | "grocery";

export const VIEW_SCOPE: Record<CareArea, CaregiverScope> = {
  medications: "care:medications",
  grocery: "care:grocery",
};
export const APPROVE_SCOPE: Record<CareArea, CaregiverScope> = {
  medications: "care:medications:approve",
  grocery: "care:grocery:approve",
};

type PermStore = Pick<AgentStore, "getCaregiverPermission">;

/**
 * Backend check for Care data. The older adult always sees their own data; the system acts for them.
 * A caregiver needs the Care agent permission AND the specific scope (`care:medications` /
 * `care:grocery`). Pantry and meals are food data and fall under `care:grocery`.
 */
export async function canAccessCare(ctx: AgentContext, area: CareArea, mode: "view" | "approve", perms: PermStore) {
  if (ctx.actor.role === "older_adult") return ctx.actor.id === ctx.userId;
  if (ctx.actor.role === "system") return true;
  const perm = await perms.getCaregiverPermission(ctx.userId, ctx.actor.id, "care");
  if (!grantActive(perm, Date.now())) return false;
  const scopes = perm.scopes ?? [];
  if (mode === "view") return perm.canViewSummaries && scopes.includes(VIEW_SCOPE[area]);
  return perm.canApprove && scopes.includes(APPROVE_SCOPE[area]) && scopes.includes(VIEW_SCOPE[area]);
}

export async function assertCareAccess(ctx: AgentContext, area: CareArea, mode: "view" | "approve", perms: PermStore) {
  if (!(await canAccessCare(ctx, area, mode, perms))) {
    throw new AgentError(
      "PERMISSION_DENIED",
      `${ctx.actor.role} ${ctx.actor.id} lacks ${mode === "view" ? VIEW_SCOPE[area] : APPROVE_SCOPE[area]}`,
    );
  }
}

/**
 * Which Care area each approval-gated tool belongs to, and whether only the older adult may decide it.
 * Consent-type actions (sharing a help request) can't be approved by a caregiver on the user's behalf.
 */
export const APPROVAL_AREAS: Record<string, { area: CareArea; userOnly?: boolean }> = {
  submitPharmacyRefill: { area: "medications" },
  updateMedicationSchedule: { area: "medications" },
  addMedication: { area: "medications" },
  requestOrderApproval: { area: "grocery" },
  respondToCartSuggestion: { area: "grocery" },
  bookMealDelivery: { area: "grocery" },
  requestPhysicalAssistance: { area: "grocery", userOnly: true },
  // bookHomeRepair is deliberately absent (person-only; see accessRules.TOOL_AREA).
};
