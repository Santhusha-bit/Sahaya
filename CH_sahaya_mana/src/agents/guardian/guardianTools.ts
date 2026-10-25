import { z } from "zod";
import { notYetImplemented } from "../base/scaffold";
import { defineTool, type AnyTool } from "../base/ToolRegistry";

const owner = "guardian" as const;
const M2 = "M2";

export const GUARDIAN_NAMESPACES = [
  "guardian.incidents",
  "guardian.verifications",
  "guardian.trustedContactWorkflows",
  "guardian.assistance",
];

export const guardianTools: AnyTool[] = [
  defineTool({
    name: "analyzeSuspiciousConversation",
    owner,
    description:
      "Assess a call, text, email, or in-person contact for scam or fraud indicators. Returns a risk level, the specific red flags found, and recommended next steps.",
    input: z.object({
      channel: z.enum(["phone", "sms", "email", "in_person", "social_media", "other"]),
      claimedIdentity: z.string().max(200).describe("Who the contact claimed to be, e.g. 'grandson', 'IRS', 'Medicare'"),
      description: z.string().min(10).max(4000).describe("What was said or asked, in the user's words"),
      requestedAction: z.string().max(500).optional().describe("What they asked the user to do, e.g. buy gift cards"),
    }),
    risk: "read",
    handler: notYetImplemented("analyzeSuspiciousConversation", M2),
  }),
  defineTool({
    name: "initiateTrustedVerification",
    owner,
    description:
      "Verify a claim through an independent trusted channel (an official phone number or a trusted contact), never via the contact who reached out.",
    input: z.object({
      claim: z.string().min(5).max(500),
      method: z.enum(["call_official_number", "ask_trusted_contact", "check_official_website"]),
      trustedContactId: z.string().max(64).optional(),
      incidentId: z.string().max(64).optional(),
    }),
    risk: "write",
    requiresApproval: (input) => input.method === "ask_trusted_contact",
    summarize: (i) => `Verify "${i.claim}" via ${i.method.replace(/_/g, " ")}`,
    handler: notYetImplemented("initiateTrustedVerification", M2),
  }),
  defineTool({
    name: "createSecurityIncident",
    owner,
    description: "Record a security incident (suspected scam, fraud, or safety event) in Guardian's history.",
    input: z.object({
      type: z.enum(["scam_attempt", "fraud", "account_compromise", "physical_safety", "other"]),
      severity: z.enum(["low", "medium", "high", "urgent"]),
      summary: z.string().min(5).max(1000),
      indicators: z.array(z.string().max(200)).max(20).default([]),
    }),
    risk: "write",
    handler: notYetImplemented("createSecurityIncident", M2),
  }),
  defineTool({
    name: "requestEmergencyAssistance",
    owner,
    description:
      "Request emergency assistance and alert all emergency contacts. Use only for immediate danger; always tell the user to call 911 first.",
    input: z.object({
      emergencyType: z.enum(["medical", "fall", "fire", "intruder", "other"]),
      summary: z.string().min(5).max(500),
      locationHint: z.string().max(200).optional(),
    }),
    risk: "sensitive",
    summarize: (i) => `Alert emergency contacts: ${i.emergencyType} — ${i.summary}`,
    integrations: ["telephony"],
    handler: notYetImplemented("requestEmergencyAssistance", M2),
  }),
  defineTool({
    name: "notifyTrustedContact",
    owner,
    description: "Send a message to one of the user's trusted contacts.",
    input: z.object({
      trustedContactId: z.string().min(1).max(64),
      message: z.string().min(5).max(600),
      urgency: z.enum(["fyi", "soon", "urgent"]),
    }),
    risk: "sensitive",
    summarize: (i) => `Message trusted contact (${i.urgency}): "${i.message.slice(0, 80)}"`,
    handler: notYetImplemented("notifyTrustedContact", M2),
  }),
  defineTool({
    name: "createHumanAssistanceRequest",
    owner,
    description: "Open a request for in-person help (e.g. picking up medication, a ride, help at home).",
    input: z.object({
      need: z.enum(["medication_pickup", "grocery_pickup", "mobility", "home_task", "other"]),
      details: z.string().min(5).max(800),
      neededBy: z.number().int().positive().optional().describe("Unix ms deadline"),
      sourceEventId: z.string().max(64).optional(),
    }),
    risk: "write",
    handler: notYetImplemented("createHumanAssistanceRequest", M2),
  }),
  defineTool({
    name: "scheduleHelper",
    owner,
    description: "Assign a trusted helper to an open assistance request at a specific time.",
    input: z.object({
      requestId: z.string().min(1).max(64),
      helperContactId: z.string().min(1).max(64),
      scheduledFor: z.number().int().positive(),
    }),
    risk: "sensitive",
    summarize: (i) => `Ask helper ${i.helperContactId} to assist at ${new Date(i.scheduledFor).toLocaleString()}`,
    handler: notYetImplemented("scheduleHelper", M2),
  }),
  defineTool({
    name: "trackAssistanceResponse",
    owner,
    description: "Check or update the status of an assistance request (acknowledged, en route, completed).",
    input: z.object({
      requestId: z.string().min(1).max(64),
      update: z.enum(["check", "acknowledged", "en_route", "completed", "cancelled"]).default("check"),
    }),
    risk: "write",
    handler: notYetImplemented("trackAssistanceResponse", M2),
  }),
];
