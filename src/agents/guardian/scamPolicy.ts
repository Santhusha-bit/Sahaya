/**
 * Guardian scam policy engine — PURE, deterministic, no I/O.
 *
 * This is the security authority for the scam workflow. Claude's output (and the
 * regex signal detector in sandbox mode) is ADVISORY only: it describes a message.
 * Nothing it says can authorize an action. Every security decision is made here,
 * in code, so it is auditable and unit-testable in isolation (prompt global rule
 * 3: deterministic enforcement).
 *
 * The five rules, encoded below:
 *   R1  Never disclose personal / financial / contact info based on an inbound
 *       message.
 *   R2  Any payment / gift card / wire / crypto action is blocked unless a valid
 *       approval exists.
 *   R3  Contact details / callback numbers supplied INSIDE the message are ignored
 *       (never used for verification).
 *   R4  Verification contacts a person from the trusted-contact directory only,
 *       through the stored channel.  -> selectVerificationContact()
 *   R5  Caregivers see an incident only if they hold the `incidents:view`
 *       permission.                  -> canViewIncidents()
 */

import type { RiskLevel, ScamSignal, SignalAnalysis } from "./scamSignals";

export type DiscloseKind =
  | "ssn"
  | "bank"
  | "card"
  | "code"
  | "password"
  | "address"
  | "contact"
  | "other";

export type PaymentMethod = "gift_card" | "wire" | "crypto" | "zelle" | "card" | "other";

/** What the inbound message is asking the person to DO. Derived, never trusted. */
export interface RequestedAction {
  type: "payment" | "disclose" | "none";
  paymentMethod?: PaymentMethod;
  discloseKind?: DiscloseKind;
  amount?: number;
  raw?: string;
}

export interface PolicyContext {
  /** True only if a VALID approval authorizes this specific payment. */
  hasPaymentApproval: boolean;
}

export type PolicyEffect = "allow" | "block";

export interface PolicyDecision {
  /** Stable rule id, e.g. "R2_payment_requires_approval". */
  rule: string;
  effect: PolicyEffect;
  reason: string;
}

export type PolicyOutcome = "blocked" | "verify" | "allowed";

export interface PolicyResult {
  decisions: PolicyDecision[];
  /** True if any rule blocked an action the message requested. */
  blocked: boolean;
  outcome: PolicyOutcome;
}

const IRREVERSIBLE: PaymentMethod[] = ["gift_card", "wire", "crypto", "zelle"];

function discloseLabel(kind: DiscloseKind): string {
  const map: Record<DiscloseKind, string> = {
    ssn: "a Social Security number",
    bank: "bank account details",
    card: "card numbers",
    code: "a verification / one-time code",
    password: "a password or PIN",
    address: "a home address",
    contact: "personal contact details",
    other: "sensitive personal information",
  };
  return map[kind];
}

/**
 * The deterministic decision. Given what a message asks for (`action`), the
 * advisory `analysis`, and the trusted `context`, return the policy verdict.
 *
 * Note: a HIGH advisory risk never, on its own, flips an allow to a block — and a
 * LOW advisory risk never unblocks a payment. The action + approval state decide.
 */
export function evaluateScamPolicy(input: {
  analysis: SignalAnalysis;
  action: RequestedAction;
  context: PolicyContext;
}): PolicyResult {
  const { analysis, action, context } = input;
  const decisions: PolicyDecision[] = [];

  // R1 — never disclose anything in response to an inbound message.
  if (action.type === "disclose") {
    const kind = action.discloseKind ?? "other";
    decisions.push({
      rule: "R1_no_disclosure_from_inbound",
      effect: "block",
      reason: `Blocked: never share ${discloseLabel(kind)} because an inbound message asked for it.`,
    });
  }

  // R2 — payments are blocked unless a valid approval exists.
  if (action.type === "payment") {
    const method = action.paymentMethod ?? "other";
    const irreversible = IRREVERSIBLE.includes(method);
    if (!context.hasPaymentApproval) {
      decisions.push({
        rule: "R2_payment_requires_approval",
        effect: "block",
        reason: irreversible
          ? `Blocked: ${method.replace("_", " ")} transfers are irreversible and require explicit approval that does not exist.`
          : `Blocked: no valid approval exists for this payment.`,
      });
    } else {
      decisions.push({
        rule: "R2_payment_requires_approval",
        effect: "allow",
        reason: "A valid approval authorizes this payment.",
      });
    }
  }

  // R3 — ignore any contact details embedded in the message.
  if (analysis.embeddedContacts.length) {
    decisions.push({
      rule: "R3_ignore_embedded_contacts",
      effect: "block",
      reason: `Ignored ${analysis.embeddedContacts.length} contact detail(s) supplied inside the message; verification uses the trusted directory only.`,
    });
  }

  const blocked = decisions.some(
    (d) => d.effect === "block" && (d.rule === "R1_no_disclosure_from_inbound" || d.rule === "R2_payment_requires_approval"),
  );

  let outcome: PolicyOutcome;
  if (blocked) outcome = "blocked";
  else if (riskAtLeast(analysis.risk, "medium")) outcome = "verify";
  else outcome = "allowed";

  return { decisions, blocked, outcome };
}

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

export function riskAtLeast(risk: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(floor);
}

/** ---- R4: verification contact selection ---- */

export interface TrustedContact {
  name: string;
  relationship?: string;
  /** Stored channel used to reach them, e.g. "phone", "sms". */
  channel: string;
  /** Stored, trusted phone — never one supplied by the message. */
  phone?: string;
}

export type VerificationMethod = "callback_known_number" | "code_word" | "trusted_contact";

export interface VerificationPlan {
  contact: TrustedContact;
  method: VerificationMethod;
}

/**
 * R3 + R4: pick who to verify with. ONLY the trusted-contact directory is
 * consulted. Any `claimantHint` from the message is used only to pick the best
 * matching trusted contact — it can never introduce a new contact or number.
 */
export function selectVerificationContact(
  trustedContacts: TrustedContact[],
  claimantHint?: string,
): VerificationPlan | null {
  if (!trustedContacts.length) return null;

  let contact = trustedContacts[0];
  if (claimantHint) {
    const hint = claimantHint.toLowerCase();
    const match = trustedContacts.find(
      (c) =>
        hint.includes(c.name.toLowerCase()) ||
        (c.relationship ? hint.includes(c.relationship.toLowerCase()) : false),
    );
    if (match) contact = match;
  }

  const method: VerificationMethod = contact.phone ? "callback_known_number" : "trusted_contact";
  return { contact, method };
}

/** ---- R5: caregiver incident visibility ---- */

export interface Caregiver {
  name: string;
  relationship?: string;
  channel?: string;
  permissions: string[];
}

export const INCIDENTS_VIEW = "incidents:view";

export function canViewIncidents(caregiver: Pick<Caregiver, "permissions">): boolean {
  return caregiver.permissions.includes(INCIDENTS_VIEW);
}

export function caregiversWhoCanView(caregivers: Caregiver[]): Caregiver[] {
  return caregivers.filter(canViewIncidents);
}

export type { RiskLevel, ScamSignal };
