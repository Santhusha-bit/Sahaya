import { z } from "zod";
import type { AgentTool } from "../base/types";
import { getIncidentIndex } from "@/integrations/search";
import { sendSms, twilioSmsConfigured } from "@/integrations/twilio";
import { detectSignals } from "./scamSignals";
import { runScamScreening } from "./scamWorkflow";

export const guardianTools: AgentTool[] = [
  {
    name: "analyzeSuspiciousConversation",
    description:
      "Analyze a message, call transcript, or request the person received and score how likely it is to be a scam. Advisory only: it describes the message and never decides what happens. Call this before advising on anything suspicious.",
    inputSchema: z.object({
      content: z.string().min(1).describe("What the suspicious person said or wrote."),
      channel: z.enum(["phone", "text", "email", "in_person", "other"]).optional(),
    }),
    async execute(input, ctx) {
      const analysis = detectSignals(input.content);
      const flags = analysis.signals.map((s) => s.label);
      const risk = analysis.risk;
      const rec = await ctx.memory.save("analyses", {
        content: input.content.slice(0, 800),
        channel: input.channel ?? "other",
        risk,
        score: analysis.score,
        flags,
      });
      const advice =
        risk === "critical" || risk === "high"
          ? "This has strong scam indicators. Do not send money, codes, or personal details. I recommend we notify a trusted contact."
          : risk === "medium"
            ? "This is suspicious. Let's verify who it really is before doing anything they ask."
            : "No strong scam signals, but stay cautious and never share codes or payment details.";
      return {
        ok: true,
        summary: `Risk: ${risk.toUpperCase()}${flags.length ? ` (${flags.length} signal(s))` : ""}. ${advice}`,
        data: { analysisId: rec.id, risk, score: analysis.score, flags },
      };
    },
  },
  {
    name: "screenInboundMessage",
    description:
      "Run the full Guardian scam workflow on a suspicious inbound message: detect signals, apply the deterministic safety policy, verify through a trusted contact, record an incident, and alert authorized caregivers. Use this for any message that asks for money, gift cards, codes, or personal information.",
    inputSchema: z.object({
      content: z.string().min(1).describe("The suspicious message, call transcript, or request, verbatim."),
      channel: z.enum(["phone", "text", "email", "in_person", "other"]).default("other"),
      claimant: z.string().optional().describe("Who the sender claims to be, if stated."),
    }),
    async execute(input, ctx) {
      const result = await runScamScreening(
        { message: input.content, channel: input.channel, claimant: input.claimant },
        ctx,
      );
      const blockedActions = result.incident.policyDecisions
        .filter((d) => d.effect === "block")
        .map((d) => d.reason);
      return {
        ok: true,
        summary: result.warning,
        data: {
          incidentId: result.incident.id,
          risk: result.incident.riskLevel,
          outcome: result.incident.outcome,
          blocked: result.blocked,
          blockedActions,
          verification: result.incident.verification,
          caregiversAlerted: result.incident.visibility.caregiversAlerted,
        },
      };
    },
  },
  {
    name: "searchPastIncidents",
    description:
      "Search the person's own past scam incidents to answer 'has someone tried this before?'. Returns matching incidents with ids, dates, and evidence snippets. Only the person's own incidents are searched. Summarize similarities without claiming it is the same caller.",
    inputSchema: z.object({
      query: z.string().min(1).describe("What to look for, e.g. 'gift card grandson' or the suspicious message."),
      channel: z.enum(["phone", "text", "email", "in_person", "other"]).optional(),
      scamType: z.string().optional().describe("Filter by scam type, e.g. 'gift_card', 'fake_bank'."),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    async execute(input, ctx) {
      const hits = await getIncidentIndex().search({
        query: input.query,
        userId: ctx.userId,
        filters: { channel: input.channel, scamType: input.scamType },
        limit: input.limit ?? 5,
      });
      if (!hits.length) {
        return { ok: true, summary: "I couldn't find a similar past incident in your history.", data: { hits: [] } };
      }
      const top = hits[0];
      const when = new Date(top.doc.receivedAt).toISOString().slice(0, 10);
      const lines = hits.map((h) => {
        const d = new Date(h.doc.receivedAt).toISOString().slice(0, 10);
        return `• ${d} [${h.doc.incidentId}] (${h.doc.scamType}, ${h.doc.riskLevel}): ${h.snippet}`;
      });
      return {
        ok: true,
        summary: `Yes — the closest match is ${top.doc.scamType} from ${when} (incident ${top.doc.incidentId}). This looks similar in tactic, though it may not be the same caller.\n${lines.join("\n")}`,
        data: {
          hits: hits.map((h) => ({ incidentId: h.doc.incidentId, scamType: h.doc.scamType, riskLevel: h.doc.riskLevel, receivedAt: h.doc.receivedAt, score: h.score, snippet: h.snippet })),
        },
      };
    },
  },
  {
    name: "initiateTrustedVerification",
    description:
      "Start a verification workflow to confirm whether a caller or visitor is who they claim to be, using a known trusted contact or a shared code word.",
    inputSchema: z.object({
      claimant: z.string().min(1).describe("Who the person claims to be, e.g. 'the bank' or 'grandson Mark'."),
      method: z.enum(["callback_known_number", "code_word", "trusted_contact"]).default("trusted_contact"),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("verifications", {
        claimant: input.claimant,
        method: input.method,
        status: "in_progress",
      });
      const steps: Record<string, string> = {
        callback_known_number: "Hang up and call the organization back on the official number you already have.",
        code_word: "Ask them for the family code word. A real family member will know it.",
        trusted_contact: "Let's confirm with a trusted contact before trusting this person.",
      };
      return {
        ok: true,
        summary: `Verification started for "${input.claimant}". ${steps[input.method]}`,
        data: { verificationId: rec.id },
      };
    },
  },
  {
    name: "createSecurityIncident",
    description: "Record a security incident so it appears in the person's history and the caregiver dashboard.",
    inputSchema: z.object({
      summary: z.string().min(1),
      severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      relatedAnalysisId: z.string().optional(),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save(
        "incidents",
        { summary: input.summary, severity: input.severity, relatedAnalysisId: input.relatedAnalysisId, status: "open" },
        { tags: ["incident", input.severity] },
      );
      return { ok: true, summary: `Logged a ${input.severity} security incident.`, data: { incidentId: rec.id } };
    },
  },
  {
    name: "requestEmergencyAssistance",
    description:
      "Request urgent human/emergency assistance for the person. Sensitive: requires the person's approval before it is dispatched.",
    inputSchema: z.object({
      situation: z.string().min(1).describe("What is happening right now."),
      severity: z.enum(["high", "critical"]).default("high"),
    }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: "Dispatch emergency assistance",
      description: `Guardian wants to request urgent help: "${input.situation}". Approve to proceed.`,
    }),
    async execute(input, ctx) {
      const incident = await ctx.memory.save(
        "incidents",
        { summary: `Emergency: ${input.situation}`, severity: input.severity, status: "dispatched" },
        { tags: ["incident", "emergency"] },
      );
      await ctx.tasks.create({
        title: "Emergency assistance dispatched",
        description: input.situation,
        steps: ["Assistance requested", "Awaiting responder", "Resolved"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      return {
        ok: true,
        summary: "Emergency assistance has been requested. Stay on the line with me — help is being arranged.",
        data: { incidentId: incident.id },
      };
    },
  },
  {
    name: "notifyTrustedContact",
    description:
      "Send a short alert to one of the person's trusted contacts. Sensitive: requires approval. Reads the trusted-contact list from shared household memory.",
    inputSchema: z.object({
      contactName: z.string().min(1),
      message: z.string().min(1).max(300),
    }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: `Message ${input.contactName}`,
      description: `Guardian wants to tell ${input.contactName}: "${input.message}"`,
    }),
    async execute(input, ctx) {
      const contacts = await ctx.memory.readShared("trustedContacts");
      const match = contacts.find(
        (c) => String(c.data.name ?? "").toLowerCase() === input.contactName.toLowerCase(),
      );
      const phone = match?.data.phone ? String(match.data.phone) : undefined;

      // Deliver via Twilio SMS when the contact has a phone number. Honest
      // live/sandbox: sendSms() only reports backend "twilio" with sent=true when a
      // real Twilio send succeeded, otherwise "sandbox" (nothing left the device).
      // We record whatever actually happened and never claim an SMS we didn't send.
      let channel: "sms" | "in_app" = "in_app";
      let delivered = true;
      let smsError: string | undefined;
      let smsSid: string | undefined;
      if (phone) {
        const sms = await sendSms({ to: phone, body: `Kinline Guardian: ${input.message}` });
        channel = sms.backend === "twilio" && sms.sent ? "sms" : "in_app";
        delivered = sms.sent || channel === "in_app";
        smsError = sms.reason;
        smsSid = sms.sid;
      }

      const rec = await ctx.memory.save("notifications", {
        contactName: input.contactName,
        message: input.message,
        delivered,
        channel,
        smsAttempted: !!phone,
        smsDelivered: channel === "sms",
        smsSid,
        ...(smsError ? { smsError } : {}),
      });
      await ctx.audit.record({
        actor: "guardian",
        action: "contact.notify",
        correlationId: ctx.correlationId,
        detail: { to: input.contactName, channel, delivered, smsDelivered: channel === "sms" },
      });

      const deliveryNote =
        channel === "sms"
          ? "I texted them."
          : phone
            ? twilioSmsConfigured()
              ? "The text couldn't be sent just now, so I logged the alert in the app for them."
              : "I logged the alert in the app for them (live SMS isn't configured, so nothing was texted)."
            : "I logged the alert in the app for them.";
      return {
        ok: true,
        summary: match
          ? `Alerted ${input.contactName}. ${deliveryNote}`
          : `Sent to ${input.contactName} (not in trusted list yet — consider adding them). ${deliveryNote}`,
        data: { notificationId: rec.id, channel, delivered, smsDelivered: channel === "sms" },
      };
    },
  },
  {
    name: "createHumanAssistanceRequest",
    description: "Create a request for a human helper to assist the person physically (e.g. collecting medication).",
    inputSchema: z.object({
      need: z.string().min(1),
      urgency: z.enum(["routine", "soon", "urgent"]).default("soon"),
      location: z.string().optional(),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save(
        "assistance",
        { need: input.need, urgency: input.urgency, location: input.location, status: "open" },
        { tags: ["assistance", input.urgency] },
      );
      await ctx.tasks.create({
        title: `Coordinate help: ${input.need}`,
        steps: ["Request created", "Helper assigned", "Help delivered"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      return { ok: true, summary: `Created a ${input.urgency} assistance request: ${input.need}.`, data: { requestId: rec.id } };
    },
  },
  {
    name: "scheduleHelper",
    description: "Schedule a helper to arrive at a given time for an assistance request.",
    inputSchema: z.object({
      requestId: z.string().optional(),
      helper: z.string().min(1).describe("Who will help, e.g. 'neighbor Sandra' or 'home-care aide'."),
      when: z.string().min(1).describe("Human-readable time, e.g. 'tomorrow 10am'."),
    }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save("scheduledHelpers", {
        requestId: input.requestId,
        helper: input.helper,
        when: input.when,
        status: "scheduled",
      });
      return { ok: true, summary: `Scheduled ${input.helper} for ${input.when}.`, data: { scheduleId: rec.id } };
    },
  },
  {
    name: "trackAssistanceResponse",
    description: "Check the status of assistance requests and scheduled helpers.",
    inputSchema: z.object({ requestId: z.string().optional() }),
    async execute(input, ctx) {
      const assistance = await ctx.memory.list("assistance");
      const helpers = await ctx.memory.list("scheduledHelpers");
      const filtered = input.requestId
        ? assistance.filter((a) => a.id === input.requestId)
        : assistance;
      return {
        ok: true,
        summary: `${filtered.length} assistance request(s), ${helpers.length} scheduled helper(s).`,
        data: {
          requests: filtered.map((a) => ({ id: a.id, need: a.data.need, status: a.data.status })),
          helpers: helpers.map((h) => ({ helper: h.data.helper, when: h.data.when, status: h.data.status })),
        },
      };
    },
  },
];
