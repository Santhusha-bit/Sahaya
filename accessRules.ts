/**
 * Caregiver access rules for Care data, shared by the app (MemoryStore/Next routes) and the Convex functions
 * (defence in depth: the database enforces the same rules even if the app layer were bypassed).
 * Pure module: no runtime dependencies, so convex/agentStore.ts can import it.
 *
 * Capabilities: care:medications (view), care:medications:approve, care:grocery (view; pantry and meals are
 * food data), care:grocery:approve. Conversations, learned profile details, pending read-backs and session state
 * are never visible to caregivers.
 */
export type CareArea = "medications" | "grocery";
type Rule = CareArea | "any" | "filtered" | "none";

export const NAMESPACE_RULE: Record<string, Rule> = {
  "care.medications": "medications",
  "care.confirmations": "medications",
  "care.refills": "medications",
  "care.groceryPreferences": "grocery",
  "care.shoppingHistory": "grocery",
  "care.pantry": "grocery",
  "care.orders": "grocery",
  "care.carts": "grocery",
  "care.cooking": "grocery",
  "care.profile": "any",
  "care.helpRequests": "any",
  "care.alerts": "filtered",
  "care.voice": "filtered",
  "care.memory": "filtered",
  // Home repairs: requests, proposals and approvals are the person's own; only booking rows are readable, and only
  // with the view-only care:home-services scope (see caregiverMayRead). Caregivers never write here.
  "care.homeServices": "filtered",
};

/** Learned-memory kinds → area (profile kinds are never shared). Kept in sync with KIND_AREA in memory/facts.ts (tested). */
export const MEMORY_KIND_AREA: Record<string, CareArea | "profile"> = {
  name: "profile",
  address_as: "profile",
  accessibility: "profile",
  caregiver: "profile",
  other: "profile",
  reminder_preference: "medications",
  grocery_preference: "grocery",
  brand_preference: "grocery",
  usual_item: "grocery",
  allergy: "grocery",
  dietary_restriction: "grocery",
  household_essential: "grocery",
  cooking_preference: "grocery",
  meal_habit: "grocery",
};

/** Approval-gated tools → area; userOnly = a caregiver can never decide it. Kept in sync with APPROVAL_AREAS (tested). */
export const TOOL_AREA: Record<string, { area: CareArea; userOnly?: boolean }> = {
  submitPharmacyRefill: { area: "medications" },
  updateMedicationSchedule: { area: "medications" },
  addMedication: { area: "medications" },
  requestOrderApproval: { area: "grocery" },
  respondToCartSuggestion: { area: "grocery" },
  bookMealDelivery: { area: "grocery" },
  requestPhysicalAssistance: { area: "grocery", userOnly: true },
  // bookHomeRepair is deliberately absent: with no area, caregivers can't see, decide or consume it — only the person
  // can approve, change or decline a home-repair booking.
};

export const viewScope = (a: CareArea) => `care:${a}`;
/** View-only: see the person's home-repair bookings. There is no approve scope for home repairs. */
export const HOME_SERVICES_SCOPE = "care:home-services";
export function canViewHomeServices(g: GrantLike) {
  return g.canViewSummaries && (g.scopes ?? []).includes(HOME_SERVICES_SCOPE);
}
export const approveScope = (a: CareArea) => `care:${a}:approve`;

export interface GrantLike {
  canViewSummaries: boolean;
  canApprove: boolean;
  scopes?: string[];
  revokedAt?: number;
  expiresAt?: number;
}

/** Not revoked and not expired (agent-level grants for other agents may have no scopes). */
export function grantLive(g: GrantLike | null | undefined, now: number): g is GrantLike {
  return Boolean(g && !g.revokedAt && (g.expiresAt === undefined || g.expiresAt > now));
}

/** A Care grant counts only if live and carrying at least one capability. */
export function grantActive(g: GrantLike | null | undefined, now: number): g is GrantLike {
  return grantLive(g, now) && (g!.scopes ?? []).length > 0;
}

export function canView(g: GrantLike, area: CareArea) {
  return g.canViewSummaries && (g.scopes ?? []).includes(viewScope(area));
}
export function canApprove(g: GrantLike, area: CareArea) {
  return g.canApprove && canView(g, area) && (g.scopes ?? []).includes(approveScope(area));
}
export function anyApprove(g: GrantLike) {
  return canApprove(g, "medications") || canApprove(g, "grocery");
}

/** Area of one stored row in a "filtered" namespace, or null if caregivers never see it. */
export function rowArea(namespace: string, value: unknown): CareArea | null {
  const v = (value ?? {}) as Record<string, unknown>;
  if (namespace === "care.alerts") return v.area === "medications" || v.area === "grocery" ? v.area : null;
  if (namespace === "care.voice") return typeof v.purpose === "string" ? (v.purpose.startsWith("medication") ? "medications" : "grocery") : null;
  if (namespace === "care.memory") {
    if (v.tombstone) return null;
    const area = typeof v.kind === "string" ? MEMORY_KIND_AREA[v.kind] : undefined;
    return area === "medications" || area === "grocery" ? area : null;
  }
  return null;
}

/** May a caregiver with this grant read this row? */
export function caregiverMayRead(g: GrantLike, namespace: string, value: unknown): boolean {
  const rule = NAMESPACE_RULE[namespace];
  if (!rule || rule === "none") return false;
  if (rule === "any") return canView(g, "medications") || canView(g, "grocery");
  if (namespace === "care.homeServices") {
    return canViewHomeServices(g) && (value as { kind?: unknown } | null)?.kind === "booking";
  }
  if (rule === "filtered") {
    const area = rowArea(namespace, value);
    return area !== null && canView(g, area);
  }
  return canView(g, rule);
}

/**
 * May a caregiver write this row? Only while carrying out an action they're allowed to approve (writes in that
 * area), acknowledging an alert they can see, or leaving the decision notice for the person's agent.
 */
export function caregiverMayWrite(g: GrantLike, namespace: string, value: unknown): boolean {
  if (namespace === "care.notices" || namespace === "care.sandbox") return anyApprove(g);
  const rule = NAMESPACE_RULE[namespace];
  if (namespace === "care.alerts") {
    const area = rowArea(namespace, value);
    return area !== null && canView(g, area);
  }
  if (rule === "medications" || rule === "grocery") return canApprove(g, rule);
  return false;
}
