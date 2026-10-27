import { z } from "zod";

/**
 * Cross-agent event payload schemas — the wire protocol between independent agents.
 * Each payload carries only the minimum fields needed for the target to act. Agents
 * opt in by listing these in their own outbound/inbound contracts; the bus enforces
 * both sides plus user consent. Never add free-form conversation fields here.
 */

const summary = z.string().min(1).max(500);

export const EVENT_TYPES = {
  safetyConcern: "safety_concern_escalation",
  physicalAssistance: "physical_assistance_request",
  paymentReview: "payment_review_request",
  mealAssistance: "meal_assistance_request",
  suspiciousCharge: "suspicious_charge_alert",
} as const;

export const safetyConcernPayload = z.object({
  severity: z.enum(["low", "medium", "high", "urgent"]),
  category: z.enum(["fall_or_injury", "scam_or_fraud", "self_harm_risk", "medical", "neglect", "other"]),
  summary,
  observedAt: z.number().int().positive(),
});

export const physicalAssistancePayload = z.object({
  need: z.enum(["medication_pickup", "grocery_pickup", "mobility", "home_task", "other"]),
  summary,
  neededBy: z.number().int().positive().optional(),
  location: z.string().max(200).optional(),
});

export const paymentReviewPayload = z.object({
  orderRef: z.string().min(1).max(64),
  merchant: z.string().min(1).max(100),
  amountCents: z.number().int().positive(),
  itemCount: z.number().int().positive(),
  category: z.enum(["groceries", "pharmacy", "household"]),
});

export const mealAssistancePayload = z.object({
  difficulty: z.enum(["preparing_meals", "shopping", "low_appetite", "other"]),
  summary,
  dietaryNotes: z.string().max(300).optional(),
});

export const suspiciousChargePayload = z.object({
  merchant: z.string().min(1).max(100),
  amountCents: z.number().int().positive(),
  reason: summary,
  transactionRef: z.string().max(64),
});
