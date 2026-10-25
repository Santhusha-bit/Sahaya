import { z } from "zod";
import type { AgentTool } from "../base/types";
import type { AgentId } from "../base/types";
import { AGENT_CAPABILITIES } from "../base/workItemPolicy";
import { getHouseholdCoordinator } from "@/integrations/jira";
import { getIncidentIndex } from "@/integrations/search";
import { sendSms, twilioSmsConfigured } from "@/integrations/twilio";
import { detectSignals } from "./scamSignals";
import { runScamScreening } from "./scamWorkflow";
import { isoDate, sharedTactics, summarizeIncidentMatches } from "./incidentSummary";

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
      "Search the person's own past scam incidents to answer 'has someone tried this before?'. Pass the suspicious message (or a description of it) as the query. Returns matching incidents with ids, dates, evidence snippets, and shared tactics, plus a summary that explains the similarities. Only the person's own incidents are searched. Never claim it is the same caller.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The suspicious message itself, or what to look for, e.g. 'gift card grandson'."),
      channel: z.enum(["phone", "text", "email", "in_person", "other"]).optional(),
      scamType: z.string().optional().describe("Filter by scam type, e.g. 'gift_card', 'fake_bank'."),
      excludeIncidentId: z.string().optional().describe("The incident being asked about (e.g. one just screened), so it does not match itself."),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    async execute(input, ctx) {
      // Tactic signals in the question rank incidents that used the same playbook.
      const signals = detectSignals(input.query).signals.map((s) => s.code);
      const hits = await getIncidentIndex().search({
        query: input.query,
        userId: ctx.userId,
        filters: { channel: input.channel, scamType: input.scamType },
        signals,
        excludeIncidentIds: input.excludeIncidentId ? [input.excludeIncidentId] : undefined,
        limit: input.limit ?? 5,
      });
      const summary = await summarizeIncidentMatches({ question: input.query, hits });
      await ctx.audit.record({
        actor: "guardian",
        action: "incident.search",
        correlationId: ctx.correlationId,
        detail: { hits: hits.length, top: hits[0]?.doc.incidentId, summarizedBy: summary.by, rejected: summary.rejected },
      });
      return {
        ok: true,
        summary: summary.text,
        data: {
          summarizedBy: summary.by,
          citedIncidentIds: summary.citedIncidentIds,
          hits: hits.map((h) => ({
            incidentId: h.doc.incidentId,
            scamType: h.doc.scamType,
            riskLevel: h.doc.riskLevel,
            channel: h.doc.channel,
            outcome: h.doc.outcome,
            receivedAt: h.doc.receivedAt,
            date: isoDate(h.doc.receivedAt),
            score: h.score,
            snippet: h.snippet,
            matchedTerms: h.matchedTerms,
            sharedTactics: sharedTactics(h),
          })),
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
  {
    name: "delegateToAgent",
    description:
      "Hand a sensitive action that another agent owns (e.g. Finance paying an invoice, freezing a card, or filing a dispute) to that agent as a reviewable work item. It does NOT execute anything: a registered family reviewer must approve first, and the assigned agent can only run exactly what was approved. Code policy decides whether the delegation is allowed.",
    inputSchema: z.object({
      assignedAgent: z.enum(["finance", "care"]),
      toolName: z.enum(["executePayment", "freezeCard", "fileBillingDispute"]),
      requestedAction: z.string().min(1).max(240).describe("One line a family reviewer will read."),
      input: z.record(z.unknown()).describe("Exact parameters to approve, e.g. { amount, payee, invoiceId }."),
    }),
    async execute(input, ctx) {
      const { service, backend } = getHouseholdCoordinator(ctx.userId);
      const scope = AGENT_CAPABILITIES[input.assignedAgent as AgentId]?.find((c) => c.toolName === input.toolName)?.scope ?? "unknown";
      const item = await service.propose({
        userId: ctx.userId,
        requestedAction: input.requestedAction,
        toolName: input.toolName,
        requestingAgent: ctx.agentId,
        assignedAgent: input.assignedAgent as AgentId,
        permissionScope: scope,
        input: input.input,
      });
      await ctx.audit.record({
        actor: ctx.agentId,
        action: item.status === "rejected" ? "work_item.delegation_denied" : "work_item.delegation_proposed",
        correlationId: ctx.correlationId,
        detail: { workItemId: item.id, assignedAgent: input.assignedAgent, toolName: input.toolName },
      });
      if (item.status === "rejected") {
        const reason = item.history.find((e) => e.action === "delegation_denied")?.detail;
        return { ok: false, summary: `That hand-off isn't allowed: ${reason}`, error: "delegation_denied", data: { workItemId: item.id } };
      }
      return {
        ok: true,
        summary: `I've asked ${input.assignedAgent} to handle this, pending approval from ${item.requiredApprovals} family caregiver(s)${backend === "jira" ? ` (Jira ${item.externalKey ?? "sync pending"})` : ""}. Nothing happens until they approve.`,
        data: { workItemId: item.id, status: item.status, riskTier: item.riskTier, requiredApprovals: item.requiredApprovals, externalKey: item.externalKey, reviewBackend: backend },
      };
    },
  },
];
