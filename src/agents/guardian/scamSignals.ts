/**
 * Advisory scam-signal detection.
 *
 * In sandbox mode this deterministic detector stands in for Claude; when Claude is
 * live its structured output can populate the same shape. Either way the result is
 * ADVISORY: it describes the message. It never decides what happens — that is the
 * job of scamPolicy.ts. Inbound text is treated purely as untrusted data.
 */

import type { DiscloseKind, PaymentMethod, RequestedAction } from "./scamPolicy";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ScamSignal {
  code: string;
  label: string;
  weight: number;
}

export interface SignalAnalysis {
  signals: ScamSignal[];
  score: number;
  risk: RiskLevel;
  /** Phone numbers / callback details embedded in the message. Never trusted. */
  embeddedContacts: string[];
  /** A short hint at who the sender claims to be, for verification-contact matching. */
  claimantHint?: string;
}

const SIGNAL_RULES: { pattern: RegExp; code: string; label: string; weight: number }[] = [
  { pattern: /gift ?card|google play|steam|itunes|app ?store card/i, code: "gift_card", label: "Requests payment via gift cards", weight: 3 },
  { pattern: /wire transfer|western union|money ?gram|zelle|venmo|cash ?app|bitcoin|crypto|btc|ethereum|usdt/i, code: "irreversible_transfer", label: "Requests an irreversible transfer", weight: 3 },
  { pattern: /\b(otp|one[- ]?time (code|password|pin)|verification code|security code|2fa|auth code)\b/i, code: "code_request", label: "Asks for a verification / one-time code", weight: 3 },
  { pattern: /social security|\bssn\b|medicare number|bank account|routing number|card number|cvv|account and routing/i, code: "sensitive_numbers", label: "Asks for sensitive personal / financial numbers", weight: 3 },
  { pattern: /arrest|warrant|lawsuit|\birs\b|tax (fraud|evasion)|police|deport|suspend(ed)? your/i, code: "authority_threat", label: "Impersonates authority / threatens legal action", weight: 2 },
  { pattern: /urgent|immediately|right now|act now|final notice|today|within (the )?hour|before it'?s too late|don'?t delay/i, code: "urgency", label: "Manufactured urgency", weight: 1 },
  { pattern: /grand(son|daughter|child|ma|pa)|it'?s me|your (grandson|grandchild)|i'?m in (trouble|jail|an accident)|bail/i, code: "family_impersonation", label: "Possible family impersonation ('grandparent scam')", weight: 2 },
  { pattern: /don'?t tell|keep (this|it) (a )?secret|between us|don'?t mention this|without telling/i, code: "secrecy", label: "Pressures the person into secrecy", weight: 2 },
  { pattern: /you('?ve| have) won|congratulations|claim your prize|lottery|sweepstakes|inheritance/i, code: "prize_bait", label: "Prize / lottery / inheritance bait", weight: 2 },
  { pattern: /refund|overpaid|tech support|microsoft|apple support|your computer (is|has)|virus detected|remote access|anydesk|teamviewer/i, code: "tech_support", label: "Tech-support / refund scam pattern", weight: 2 },
];

function riskFromScore(score: number): RiskLevel {
  if (score >= 8) return "critical";
  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/** Phone-number-ish sequences embedded in the text. */
function extractEmbeddedContacts(text: string): string[] {
  const out = new Set<string>();
  const phoneRe = /(\+?\d[\d\s().-]{7,}\d)/g;
  let m: RegExpExecArray | null;
  while ((m = phoneRe.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) out.add(m[1].trim());
  }
  return [...out];
}

function extractClaimant(text: string): string | undefined {
  const patterns = [
    /it'?s\s+([A-Z][a-z]+)/,
    /this is\s+([A-Z][a-z]+)/i,
    /your\s+(grandson|granddaughter|grandchild|son|daughter|nephew|niece)\b/i,
    /from\s+(your bank|the bank|the irs|medicare|social security)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return undefined;
}

export function detectSignals(text: string): SignalAnalysis {
  let score = 0;
  const signals: ScamSignal[] = [];
  for (const r of SIGNAL_RULES) {
    if (r.pattern.test(text)) {
      score += r.weight;
      signals.push({ code: r.code, label: r.label, weight: r.weight });
    }
  }
  return {
    signals,
    score,
    risk: riskFromScore(score),
    embeddedContacts: extractEmbeddedContacts(text),
    claimantHint: extractClaimant(text),
  };
}

/**
 * Classify what the message is asking the person to DO. This drives the policy
 * engine. It is intentionally conservative: if a payment OR a disclosure is
 * detected, the policy engine gets to block it.
 */
export function classifyRequestedAction(text: string): RequestedAction {
  const t = text;

  // Payment request?
  const paymentMethod = detectPaymentMethod(t);
  const mentionsSend = /\b(send|pay|transfer|wire|buy|purchase|deposit|load)\b/i.test(t);
  if (paymentMethod || (mentionsSend && /\$|\bdollars?\b|money|cash|funds|payment/i.test(t))) {
    return {
      type: "payment",
      paymentMethod: paymentMethod ?? "other",
      amount: detectAmount(t),
      raw: t.slice(0, 200),
    };
  }

  // Disclosure request?
  const discloseKind = detectDiscloseKind(t);
  if (discloseKind) {
    return { type: "disclose", discloseKind, raw: t.slice(0, 200) };
  }

  return { type: "none" };
}

function detectPaymentMethod(t: string): PaymentMethod | undefined {
  if (/gift ?card|google play|steam|itunes|app ?store card/i.test(t)) return "gift_card";
  if (/wire transfer|western union|money ?gram/i.test(t)) return "wire";
  if (/bitcoin|crypto|btc|ethereum|usdt/i.test(t)) return "crypto";
  if (/zelle|venmo|cash ?app/i.test(t)) return "zelle";
  if (/credit card|debit card|card number/i.test(t)) return "card";
  return undefined;
}

function detectDiscloseKind(t: string): DiscloseKind | undefined {
  if (/\b(otp|one[- ]?time (code|password|pin)|verification code|security code|2fa|auth code)\b/i.test(t)) return "code";
  if (/social security|\bssn\b/i.test(t)) return "ssn";
  if (/bank account|routing number|account and routing|account number/i.test(t)) return "bank";
  if (/card number|cvv|\bpin\b/i.test(t)) return "card";
  if (/password|passcode|login|credentials/i.test(t)) return "password";
  if (/home address|where (do )?you live|your address/i.test(t)) return "address";
  // Generic "give me your ... number / details"
  if (/(give|send|tell|share|confirm|provide)\s+(me\s+)?(your|the)\s+.*(number|details|code|account)/i.test(t))
    return "contact";
  return undefined;
}

function detectAmount(t: string): number | undefined {
  const m = t.match(/\$\s?([\d,]+(?:\.\d{2})?)|\b([\d,]{3,})\s*(?:dollars|usd)\b/i);
  if (!m) return undefined;
  const raw = (m[1] ?? m[2] ?? "").replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
