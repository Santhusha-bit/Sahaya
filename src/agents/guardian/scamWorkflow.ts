/**
 * Guardian scam workflow orchestration (Track 1).
 *
 * Ties the layers together without ever letting the advisory layer decide:
 *   1. detect signals + classify the requested action (advisory)
 *   2. evaluate the deterministic policy engine   (authority)
 *   3. verify via the trusted-contact directory only (simulated)
 *   4. persist a full incident record
 *   5. alert caregivers who hold `incidents:view`
 * Every step is written to the audit log.
 */

import { id, now } from "@/lib/id";
import { getIncidentIndex, redactPII, scamTypeFromSignals } from "@/integrations/search";
import { sendSms } from "@/integrations/twilio";
import type { ToolContext } from "../base/types";
import {
  canViewIncidents,
  evaluateScamPolicy,
  selectVerificationContact,
  type Caregiver,
  type PolicyDecision,
  type RequestedAction,
  type TrustedContact,
  type VerificationMethod,
} from "./scamPolicy";
import { classifyRequestedAction, detectSignals, type RiskLevel, type ScamSignal } from "./scamSignals";

export interface VerificationResult {
  contact: string;
  relationship?: string;
  method: VerificationMethod;
  channel: string;
  status: "completed" | "unavailable";
  /** "denied" = the real person says they did not send this -> impersonation. */
  result: "denied" | "confirmed" | "unconfirmed" | "no_trusted_contact";
  startedAt: number;
  finishedAt: number;
}

export interface CaregiverAlert {
  name: string;
  relationship?: string;
  channel: string;
  message: string;
}

export interface ScamIncident {
  id: string;
  user: string;
  channel: string;
  receivedAt: number;
  rawMessage: string;
  riskLevel: RiskLevel;
  signals: ScamSignal[];
  requestedAction: RequestedAction;
  policyDecisions: PolicyDecision[];
  verification: VerificationResult | null;
  outcome: "scam_blocked" | "scam_confirmed" | "suspicious_verified" | "no_action";
  visibility: { caregiversAlerted: string[] };
}

export interface ScamWorkflowResult {
  incident: ScamIncident;
  /** Warm, plain-language message spoken back to the person. */
  warning: string;
  caregiverAlerts: CaregiverAlert[];
  blocked: boolean;
}

function toTrustedContacts(rows: { data: Record<string, unknown> }[]): TrustedContact[] {
  return rows.map((r) => ({
    name: String(r.data.name ?? ""),
    relationship: r.data.relationship ? String(r.data.relationship) : undefined,
    channel: String(r.data.channel ?? "phone"),
    phone: r.data.phone ? String(r.data.phone) : undefined,
  }));
}

function toCaregivers(rows: { data: Record<string, unknown> }[]): Caregiver[] {
  return rows.map((r) => ({
    name: String(r.data.name ?? ""),
    relationship: r.data.relationship ? String(r.data.relationship) : undefined,
    channel: r.data.channel ? String(r.data.channel) : undefined,
    permissions: Array.isArray(r.data.permissions) ? (r.data.permissions as string[]) : [],
  }));
}

function buildWarning(incident: ScamIncident): string {
  const r = incident.verification;
  if (incident.outcome === "scam_confirmed") {
    return `I'm really glad you checked with me first. This message is a scam, not your ${r?.relationship ?? "family member"}. I reached the real ${r?.contact ?? "family member"} and they did not send it. Please don't send any money or gift cards. I've made a note and let your family know, so you don't have to carry this alone.`;
  }
  if (incident.outcome === "scam_blocked") {
    return `Please pause before doing anything. This message has strong signs of a scam, so I've blocked the payment it was asking for. We never send gift cards, wires, or codes because someone messages us. Let's verify who this really is together, and I'll keep you safe.`;
  }
  if (incident.outcome === "suspicious_verified") {
    return `This felt a little off, so I checked it the safe way, through a number we already trust. Never share codes or send money just because a message asks. I'm here if anything else seems strange.`;
  }
  return `Nothing here looks dangerous, but you did the right thing by asking. Never share codes, account numbers, or send gift cards because of a message, and I'll always help you check.`;
}

/**
 * Run the full scam screening for one inbound message.
 *
 * `hasPaymentApproval` defaults to false: an inbound message can never carry its
 * own authorization, so the policy engine always blocks the payment it requests.
 */
export async function runScamScreening(
  input: { message: string; channel?: string; claimant?: string },
  ctx: ToolContext,
): Promise<ScamWorkflowResult> {
  const channel = input.channel ?? "unknown";
  const receivedAt = now();

  // 1. Advisory detection.
  const analysis = detectSignals(input.message);
  const action = classifyRequestedAction(input.message);
  await ctx.audit.record({
    actor: "guardian",
    action: "scam.detect",
    correlationId: ctx.correlationId,
    detail: { risk: analysis.risk, signals: analysis.signals.map((s) => s.code), actionType: action.type },
  });

  // 2. Deterministic policy decision.
  const policy = evaluateScamPolicy({ analysis, action, context: { hasPaymentApproval: false } });
  await ctx.audit.record({
    actor: "guardian",
    action: "scam.policy",
    correlationId: ctx.correlationId,
    detail: { outcome: policy.outcome, decisions: policy.decisions },
  });

  // 3. Verification via the trusted directory only (simulated).
  let verification: VerificationResult | null = null;
  const needsVerification = policy.outcome === "verify" || policy.blocked;
  if (needsVerification) {
    const trusted = toTrustedContacts(await ctx.memory.readShared("trustedContacts"));
    const claimantHint = input.claimant ?? analysis.claimantHint;
    const plan = selectVerificationContact(trusted, claimantHint);
    const startedAt = now();
    if (!plan) {
      verification = {
        contact: "(none)", method: "trusted_contact", channel: "none",
        status: "unavailable", result: "no_trusted_contact", startedAt, finishedAt: now(),
      };
    } else {
      const impersonation = analysis.signals.some((s) => s.code === "family_impersonation");
      const matchesClaimant =
        !!claimantHint && claimantHint.toLowerCase().includes(plan.contact.name.toLowerCase());
      // Simulated callback: if the message impersonated this very person, the real
      // person denies sending it, confirming the scam.
      const result: VerificationResult["result"] =
        impersonation && matchesClaimant ? "denied" : "unconfirmed";
      verification = {
        contact: plan.contact.name,
        relationship: plan.contact.relationship,
        method: plan.method,
        channel: plan.contact.channel,
        status: "completed",
        result,
        startedAt,
        finishedAt: now(),
      };
    }
    await ctx.audit.record({
      actor: "guardian",
      action: "scam.verify",
      correlationId: ctx.correlationId,
      detail: {
        contact: verification.contact,
        method: verification.method,
        channel: verification.channel,
        result: verification.result,
      },
    });
  }

  // Outcome.
  let outcome: ScamIncident["outcome"];
  if (verification?.result === "denied") outcome = "scam_confirmed";
  else if (policy.blocked) outcome = "scam_blocked";
  else if (needsVerification) outcome = "suspicious_verified";
  else outcome = "no_action";

  // 4. Persist the full incident record.
  const incident: ScamIncident = {
    id: id("incident"),
    user: ctx.userId,
    channel,
    receivedAt,
    rawMessage: input.message,
    riskLevel: analysis.risk,
    signals: analysis.signals,
    requestedAction: action,
    policyDecisions: policy.decisions,
    verification,
    outcome,
    visibility: { caregiversAlerted: [] },
  };

  // 5. Alert caregivers who hold incidents:view (prompt policy rule 5).
  const caregiverAlerts: CaregiverAlert[] = [];
  const confirmedOrBlocked = outcome === "scam_confirmed" || outcome === "scam_blocked";
  if (confirmedOrBlocked) {
    const caregivers = toCaregivers(await ctx.memory.readShared("caregivers"));
    for (const cg of caregivers) {
      if (!canViewIncidents(cg)) continue;
      const alert: CaregiverAlert = {
        name: cg.name,
        relationship: cg.relationship,
        channel: cg.channel ?? "in_app",
        message: `Guardian blocked a likely ${incident.riskLevel}-risk scam targeting your family member on ${channel}. Outcome: ${outcome.replace("_", " ")}. No money or information was sent.`,
      };
      caregiverAlerts.push(alert);
      incident.visibility.caregiversAlerted.push(cg.name);
    }
  }

  await ctx.memory.save("incidents", incident as unknown as Record<string, unknown>, {
    tags: ["incident", incident.riskLevel, outcome],
  });
  await ctx.audit.record({
    actor: "guardian",
    action: "scam.incident",
    correlationId: ctx.correlationId,
    detail: { incidentId: incident.id, outcome, caregiversAlerted: incident.visibility.caregiversAlerted },
  });

  // Index job: PII-redacted summary goes to the incident search index.
  await getIncidentIndex().index({
    incidentId: incident.id,
    userId: ctx.userId,
    channel,
    scamType: scamTypeFromSignals(analysis.signals.map((s) => s.code)),
    riskLevel: analysis.risk,
    receivedAt,
    text: redactPII(input.message),
    signals: analysis.signals.map((s) => s.code),
  });
  await ctx.audit.record({
    actor: "guardian",
    action: "incident.indexed",
    correlationId: ctx.correlationId,
    detail: { incidentId: incident.id },
  });

  // Phone directory for outbound SMS: caregiver records carry role/permissions, so
  // reuse the trusted-contact directory (same person, keyed by name) for numbers.
  const phoneByName = new Map<string, string>();
  if (caregiverAlerts.length) {
    for (const tc of await ctx.memory.readShared("trustedContacts")) {
      const name = String(tc.data.name ?? "").toLowerCase();
      if (name && tc.data.phone) phoneByName.set(name, String(tc.data.phone));
    }
  }

  for (const alert of caregiverAlerts) {
    // Deliver via Twilio SMS when we have a number and the caregiver's channel is
    // sms/phone. Honest live/sandbox: sendSms() only reports "sms" on a real send.
    const phone = phoneByName.get(alert.name.toLowerCase());
    let deliveredChannel = alert.channel;
    let smsDelivered = false;
    let smsSid: string | undefined;
    let smsError: string | undefined;
    if (phone && (alert.channel === "sms" || alert.channel === "phone")) {
      const sms = await sendSms({ to: phone, body: `Sahaya Guardian: ${alert.message}` });
      smsDelivered = sms.backend === "twilio" && sms.sent;
      smsSid = sms.sid;
      smsError = sms.reason;
      deliveredChannel = smsDelivered ? "sms" : "in_app";
    } else if (alert.channel === "sms" || alert.channel === "phone") {
      // No number on file: this routes to the in-app caregiver dashboard instead.
      deliveredChannel = "in_app";
    }
    await ctx.memory.save(
      "notifications",
      {
        ...alert,
        channel: deliveredChannel,
        incidentId: incident.id,
        smsAttempted: !!phone,
        smsDelivered,
        smsSid,
        ...(smsError ? { smsError } : {}),
      },
      { tags: ["caregiver_alert"] },
    );
    await ctx.audit.record({
      actor: "guardian",
      action: "caregiver.alert",
      correlationId: ctx.correlationId,
      detail: { to: alert.name, channel: deliveredChannel, smsDelivered },
    });
  }

  return {
    incident,
    warning: buildWarning(incident),
    caregiverAlerts,
    blocked: policy.blocked,
  };
}
