import type { AgentId } from "./types";
import { z } from "zod";

/**
 * Authorization policy shared by all agents. Everything about what an agent may
 * read, write, or ask of another agent is declared here — not scattered across
 * tool code — so isolation and cross-agent rules are auditable in one place.
 */

/** Permissions an agent holds over shared (household / user-preference) memory. */
export interface AgentPermissions {
  sharedRead: boolean;
  sharedWrite: boolean;
}

export const AGENT_PERMISSIONS: Record<AgentId, AgentPermissions> = {
  // Guardian may read household/trusted-contact info but not rewrite preferences.
  guardian: { sharedRead: true, sharedWrite: false },
  // Care manages groceries/meals, which live partly in shared household prefs.
  care: { sharedRead: true, sharedWrite: true },
  // Wellness reads shared context (e.g. who family contacts are).
  wellness: { sharedRead: true, sharedWrite: false },
  // Finance reads shared info but never writes it.
  finance: { sharedRead: true, sharedWrite: false },
};

/**
 * The ONLY cross-agent events that are allowed. Each entry declares the
 * source, target, event type, the permitted payload shape (so entire private
 * conversations can never be forwarded), and the user-consent flag that must be
 * enabled for the event to be delivered.
 */
export interface CrossAgentRule {
  source: AgentId;
  target: AgentId;
  type: string;
  /** zod schema the payload must satisfy; also bounds what data may cross. */
  payload: z.ZodType;
  /** Consent key that must be true in the user's consent settings. */
  consentKey: string;
  description: string;
}

const safetyConcern = z.object({
  summary: z.string().max(500),
  severity: z.enum(["low", "medium", "high", "critical"]),
  observedBy: z.string().max(80).optional(),
});

const helperRequest = z.object({
  need: z.string().max(300),
  location: z.string().max(120).optional(),
  urgency: z.enum(["routine", "soon", "urgent"]),
});

const paymentReview = z.object({
  orderId: z.string().max(80),
  amount: z.number().nonnegative(),
  merchant: z.string().max(120),
  itemCount: z.number().int().nonnegative(),
});

const careAssistRequest = z.object({
  kind: z.enum(["meal", "grocery"]),
  note: z.string().max(300),
});

export const CROSS_AGENT_RULES: CrossAgentRule[] = [
  {
    source: "wellness",
    target: "guardian",
    type: "safety.escalation",
    payload: safetyConcern,
    consentKey: "wellnessToGuardian",
    description: "Wellness escalates an urgent safety concern to Guardian.",
  },
  {
    source: "care",
    target: "guardian",
    type: "assistance.request",
    payload: helperRequest,
    consentKey: "careToGuardian",
    description: "Care asks Guardian to coordinate physical human assistance.",
  },
  {
    source: "care",
    target: "finance",
    type: "payment.review",
    payload: paymentReview,
    consentKey: "careToFinance",
    description: "Care asks Finance to review a grocery payment before it is placed.",
  },
  {
    source: "wellness",
    target: "care",
    type: "care.assist",
    payload: careAssistRequest,
    consentKey: "wellnessToCare",
    description: "Wellness asks Care for meal/grocery help after a check-in.",
  },
];

export function findRule(source: AgentId, target: AgentId, type: string): CrossAgentRule | undefined {
  return CROSS_AGENT_RULES.find(
    (r) => r.source === source && r.target === target && r.type === type,
  );
}

/** Per-user consent for each cross-agent workflow. Defaults to enabled for the demo. */
export type ConsentSettings = Record<string, boolean>;

export const DEFAULT_CONSENT: ConsentSettings = {
  wellnessToGuardian: true,
  careToGuardian: true,
  careToFinance: true,
  wellnessToCare: true,
  /** Whether caregivers may see each agent's activity on the Family dashboard. */
  caregiverGuardian: true,
  caregiverCare: true,
  caregiverWellness: true,
  caregiverFinance: true,
};
