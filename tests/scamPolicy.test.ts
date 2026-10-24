import { describe, expect, it } from "vitest";
import {
  canViewIncidents,
  evaluateScamPolicy,
  selectVerificationContact,
  type RequestedAction,
  type TrustedContact,
} from "@/agents/guardian/scamPolicy";
import { classifyRequestedAction, detectSignals } from "@/agents/guardian/scamSignals";

const MARGARET =
  "Grandma it's Jake, I'm in trouble. Please send $2,000 in gift cards today and don't tell mom.";

describe("scam signal detection (advisory layer)", () => {
  it("flags gift-card, urgency, impersonation and secrecy in the Margaret message", () => {
    const a = detectSignals(MARGARET);
    const codes = a.signals.map((s) => s.code);
    expect(codes).toContain("gift_card");
    expect(codes).toContain("urgency");
    expect(codes).toContain("family_impersonation");
    expect(codes).toContain("secrecy");
    expect(a.risk === "high" || a.risk === "critical").toBe(true);
    expect(a.claimantHint?.toLowerCase()).toBe("jake");
  });

  it("classifies the request as a gift-card payment of $2000", () => {
    const action = classifyRequestedAction(MARGARET);
    expect(action.type).toBe("payment");
    expect(action.paymentMethod).toBe("gift_card");
    expect(action.amount).toBe(2000);
  });

  it("extracts an embedded callback number from a message", () => {
    const a = detectSignals("This is your bank, call us back now at 1-800-555-0199 to verify.");
    expect(a.embeddedContacts.length).toBeGreaterThanOrEqual(1);
  });
});

describe("deterministic policy engine (the authority)", () => {
  it("blocks a gift-card payment with no approval", () => {
    const action: RequestedAction = { type: "payment", paymentMethod: "gift_card", amount: 2000 };
    const analysis = detectSignals(MARGARET);
    const res = evaluateScamPolicy({ analysis, action, context: { hasPaymentApproval: false } });
    expect(res.blocked).toBe(true);
    expect(res.outcome).toBe("blocked");
    expect(res.decisions.some((d) => d.rule === "R2_payment_requires_approval" && d.effect === "block")).toBe(true);
  });

  it("allows a payment only when a valid approval exists", () => {
    const action: RequestedAction = { type: "payment", paymentMethod: "card", amount: 50 };
    const analysis = detectSignals("pay the $50 invoice");
    const res = evaluateScamPolicy({ analysis, action, context: { hasPaymentApproval: true } });
    expect(res.blocked).toBe(false);
    expect(res.decisions.some((d) => d.rule === "R2_payment_requires_approval" && d.effect === "allow")).toBe(true);
  });

  it("blocks disclosure of a one-time code regardless of advisory risk", () => {
    const action: RequestedAction = { type: "disclose", discloseKind: "code" };
    const analysis = detectSignals("just read me the verification code we texted you");
    const res = evaluateScamPolicy({ analysis, action, context: { hasPaymentApproval: true } });
    expect(res.blocked).toBe(true);
    expect(res.decisions.some((d) => d.rule === "R1_no_disclosure_from_inbound")).toBe(true);
  });

  it("a high advisory risk alone never blocks when nothing is requested", () => {
    const analysis = detectSignals("URGENT final notice! act now! you have won a prize!");
    const res = evaluateScamPolicy({ analysis, action: { type: "none" }, context: { hasPaymentApproval: false } });
    expect(res.blocked).toBe(false);
    expect(res.outcome).toBe("verify"); // suspicious -> verify, not auto-block
  });

  it("records that embedded contacts are ignored", () => {
    const analysis = detectSignals("call me back at 1-800-555-0199 and send a wire");
    const res = evaluateScamPolicy({
      analysis,
      action: { type: "payment", paymentMethod: "wire" },
      context: { hasPaymentApproval: false },
    });
    expect(res.decisions.some((d) => d.rule === "R3_ignore_embedded_contacts")).toBe(true);
  });
});

describe("verification contact selection (R3 + R4)", () => {
  const trusted: TrustedContact[] = [
    { name: "Jake", relationship: "grandson", channel: "phone", phone: "+1-555-0133" },
    { name: "Sarah", relationship: "daughter", channel: "phone", phone: "+1-555-0177" },
  ];

  it("picks the trusted contact matching the claimant, never a message-supplied number", () => {
    const plan = selectVerificationContact(trusted, "Jake");
    expect(plan?.contact.name).toBe("Jake");
    expect(plan?.contact.phone).toBe("+1-555-0133");
    expect(plan?.method).toBe("callback_known_number");
  });

  it("returns null when there is no trusted directory", () => {
    expect(selectVerificationContact([], "Jake")).toBeNull();
  });
});

describe("caregiver incident visibility (R5)", () => {
  it("only caregivers holding incidents:view can see incidents", () => {
    expect(canViewIncidents({ permissions: ["incidents:view"] })).toBe(true);
    expect(canViewIncidents({ permissions: ["tasks:view"] })).toBe(false);
    expect(canViewIncidents({ permissions: [] })).toBe(false);
  });
});
