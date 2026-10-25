import { describe, expect, it } from "vitest";
import { MEMORY_KIND_AREA, TOOL_AREA, caregiverMayRead, caregiverMayWrite, grantActive } from "@/agents/care/accessRules";
import { FACT_KINDS, KIND_AREA } from "@/agents/care/memory/facts";
import { APPROVAL_AREAS } from "@/agents/care/permissions";

describe("shared caregiver access rules", () => {
  it("stay in sync with the Care agent's own mappings (the database enforces the same areas)", () => {
    for (const k of FACT_KINDS) expect(MEMORY_KIND_AREA[k], k).toBe(KIND_AREA[k]);
    expect(TOOL_AREA).toEqual(APPROVAL_AREAS);
  });
  it("never expose conversations, read-backs or session state; profile facts stay private", () => {
    const g = { canViewSummaries: true, canApprove: true, scopes: ["care:medications", "care:medications:approve", "care:grocery", "care:grocery:approve"] };
    for (const ns of ["care.pending", "care.session", "care.notices", "care.sandbox"]) expect(caregiverMayRead(g, ns, {})).toBe(false);
    expect(caregiverMayRead(g, "care.memory", { kind: "name" })).toBe(false);
    expect(caregiverMayRead(g, "care.memory", { tombstone: true })).toBe(false);
    expect(caregiverMayWrite(g, "care.memory", { kind: "allergy" })).toBe(false);
  });
  it("revoked, expired or empty grants are inactive", () => {
    expect(grantActive({ canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], revokedAt: 1 }, 2)).toBe(false);
    expect(grantActive({ canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], expiresAt: 5 }, 6)).toBe(false);
    expect(grantActive({ canViewSummaries: true, canApprove: false, scopes: [] }, 1)).toBe(false);
    expect(grantActive({ canViewSummaries: true, canApprove: false, scopes: ["care:grocery"], expiresAt: 9 }, 6)).toBe(true);
  });
});
