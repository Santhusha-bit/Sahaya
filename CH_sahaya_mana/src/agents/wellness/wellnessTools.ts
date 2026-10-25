import { z } from "zod";
import { notYetImplemented } from "../base/scaffold";
import { defineTool, type AnyTool } from "../base/ToolRegistry";

const owner = "wellness" as const;
const M2 = "M2";

export const WELLNESS_NAMESPACES = [
  "wellness.observations",
  "wellness.symptoms",
  "wellness.trends",
  "wellness.socialContext",
  "wellness.followUps",
  "wellness.checkIns",
];

const domain = z.enum(["sleep", "appetite", "pain", "mood", "loneliness", "mobility", "energy", "cognition", "other"]);

export const wellnessTools: AnyTool[] = [
  defineTool({
    name: "startConversationalCheckIn",
    owner,
    description: "Begin a daily check-in session and get suggested topics based on recent observations and pending follow-ups.",
    input: z.object({
      kind: z.enum(["daily", "follow_up", "user_initiated"]).default("user_initiated"),
    }),
    risk: "write",
    handler: notYetImplemented("startConversationalCheckIn", M2),
  }),
  defineTool({
    name: "extractWellnessObservations",
    owner,
    description: "Structure what the user said into wellness observations (domain, sentiment, severity) without saving them.",
    input: z.object({
      userStatement: z.string().min(3).max(2000).describe("The user's own words to structure"),
    }),
    risk: "read",
    handler: notYetImplemented("extractWellnessObservations", M2),
  }),
  defineTool({
    name: "saveWellnessMemory",
    owner,
    description: "Save a wellness observation or self-reported symptom to the user's wellness history.",
    input: z.object({
      domain,
      observation: z.string().min(3).max(500),
      severity: z.number().int().min(0).max(10).optional().describe("0 = none, 10 = worst; only if the user indicated it"),
      sentiment: z.enum(["positive", "neutral", "negative"]),
      selfReportedSymptom: z.boolean().default(false),
    }),
    risk: "write",
    handler: notYetImplemented("saveWellnessMemory", M2),
  }),
  defineTool({
    name: "analyzeLongitudinalPatterns",
    owner,
    description: "Analyze saved observations over a time window to find trends (e.g. sleep worsening over 2 weeks).",
    input: z.object({
      days: z.number().int().min(3).max(180).default(14),
      domains: z.array(domain).max(9).optional(),
    }),
    risk: "read",
    handler: notYetImplemented("analyzeLongitudinalPatterns", M2),
  }),
  defineTool({
    name: "generateWellnessSummary",
    owner,
    description: "Generate a plain-language wellness summary for a period. Caregiver-facing summaries only include what the user consented to share.",
    input: z.object({
      days: z.number().int().min(1).max(90).default(7),
      audience: z.enum(["user", "caregiver"]),
    }),
    risk: "read",
    handler: notYetImplemented("generateWellnessSummary", M2),
  }),
  defineTool({
    name: "scheduleFollowUp",
    owner,
    description: "Schedule a gentle follow-up check-in about a specific topic.",
    input: z.object({
      topic: z.string().min(3).max(200),
      inHours: z.number().min(1).max(24 * 30),
    }),
    risk: "write",
    handler: notYetImplemented("scheduleFollowUp", M2),
  }),
  defineTool({
    name: "requestCaregiverNotification",
    owner,
    description: "Ask to notify the user's caregiver with a short wellbeing update. Requires the user's approval.",
    input: z.object({
      caregiverId: z.string().min(1).max(64),
      message: z.string().min(5).max(500),
      urgency: z.enum(["fyi", "soon", "urgent"]),
    }),
    risk: "sensitive",
    summarize: (i) => `Tell your caregiver (${i.urgency}): "${i.message.slice(0, 80)}"`,
    handler: notYetImplemented("requestCaregiverNotification", M2),
  }),
  defineTool({
    name: "arrangeFamilyCall",
    owner,
    description: "Arrange a call with a family member or friend at a chosen time and send them an invite.",
    input: z.object({
      contactId: z.string().min(1).max(64),
      proposedTime: z.number().int().positive(),
      note: z.string().max(300).optional(),
    }),
    risk: "sensitive",
    summarize: (i) => `Invite ${i.contactId} to a call at ${new Date(i.proposedTime).toLocaleString()}`,
    handler: notYetImplemented("arrangeFamilyCall", M2),
  }),
  defineTool({
    name: "escalateSafetyConcern",
    owner,
    description:
      "Ask the Guardian agent to escalate an urgent safety concern. Shares only severity, category and a short summary; requires the user's cross-agent permission.",
    input: z.object({
      severity: z.enum(["low", "medium", "high", "urgent"]),
      category: z.enum(["fall_or_injury", "scam_or_fraud", "self_harm_risk", "medical", "neglect", "other"]),
      summary: z.string().min(5).max(500),
    }),
    risk: "write",
    handler: notYetImplemented("escalateSafetyConcern", "M3"),
  }),
  defineTool({
    name: "requestMealAssistance",
    owner,
    description:
      "Ask the Care agent to help with meals or groceries. Shares only the difficulty and a short summary; requires the user's cross-agent permission.",
    input: z.object({
      difficulty: z.enum(["preparing_meals", "shopping", "low_appetite", "other"]),
      summary: z.string().min(5).max(500),
    }),
    risk: "write",
    handler: notYetImplemented("requestMealAssistance", "M3"),
  }),
];
