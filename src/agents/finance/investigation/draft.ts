/**
 * The outbound request: a dispute (when a confirmed finding says a charge is
 * wrong) or a clarification request (when only the balance is unexplained).
 *
 * The template is the default author. Claude may write a friendlier version,
 * but verifyLetter() must pass before any letter is used: every dollar amount
 * must come from the case's computed set, the key references must be present,
 * no long account-like numbers may appear, and no address other than the
 * approved recipient may be mentioned.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "../../base/workItems";
import { cents } from "./extract";
import type { DisputeDraft, ExtractedBill, ExtractedEob, Finding, Reconciliation } from "./types";

const usd = (n: number) => `$${n.toFixed(2)}`;
export const MAX_LETTER_CHARS = 4000;

function longDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function draftHash(d: Pick<DisputeDraft, "recipient" | "subject" | "body" | "findingIds">): string {
  return createHash("sha256")
    .update(canonicalize({ recipient: d.recipient, subject: d.subject, body: d.body, findingIds: [...d.findingIds].sort() }))
    .digest("hex")
    .slice(0, 16);
}

export interface LetterFacts {
  kind: DisputeDraft["kind"];
  recipient: { name: string; email: string };
  subject: string;
  findings: Finding[];
  amountDisputed: number;
  expectedBalance: number;
  requiredTokens: string[];
}

export function letterFacts(bill: ExtractedBill, eob: ExtractedEob, rec: Reconciliation, confirmed: Finding[]): LetterFacts | null {
  if (!confirmed.length || !bill.provider.billingEmail) return null;
  const chargeFindings = confirmed.filter((f) => f.type !== "balance_mismatch" && f.type !== "bill_arithmetic");
  const kind: DisputeDraft["kind"] = chargeFindings.length ? "dispute" : "clarification";
  const amountDisputed = kind === "dispute" ? cents(chargeFindings.reduce((s, f) => s + f.amountAtIssue, 0)) : Math.max(0, rec.difference);
  const acct = bill.accountLast4 ? `account ending ${bill.accountLast4}` : "my account";
  const subject =
    kind === "dispute"
      ? `Billing dispute: ${chargeFindings[0].type === "duplicate_charge" ? "duplicate charge" : "incorrect charge"} on ${acct}${eob.claimNumber ? ` (claim ${eob.claimNumber})` : ""}`
      : `Request for clarification of balance on ${acct}${eob.claimNumber ? ` (claim ${eob.claimNumber})` : ""}`;
  const requiredTokens = [usd(amountDisputed), usd(rec.insurerSaysYouOwe)];
  if (eob.claimNumber) requiredTokens.push(eob.claimNumber);
  return {
    kind,
    recipient: { name: `${bill.provider.name} billing office`, email: bill.provider.billingEmail },
    subject,
    findings: confirmed,
    amountDisputed,
    expectedBalance: rec.insurerSaysYouOwe,
    requiredTokens,
  };
}

/** Deterministic letter. Every number here comes from the reconciliation. */
export function templateLetter(bill: ExtractedBill, eob: ExtractedEob, rec: Reconciliation, facts: LetterFacts): string {
  const p: string[] = [];
  p.push(`Dear ${bill.provider.name} billing office,`);
  const serviceDate = bill.lines[0]?.serviceDate;
  p.push(
    `I am writing about my statement dated ${longDate(bill.statementDate) || "recently"}${bill.accountLast4 ? ` for the account ending ${bill.accountLast4}` : ""}, for services on ${longDate(serviceDate)}.`,
  );
  for (const f of facts.findings) {
    if (f.type === "duplicate_charge") {
      const billLine = f.evidence.find((e) => e.doc === "bill");
      const code = bill.lines.find((l) => l.lineId === billLine?.lineId)?.code ?? "";
      const denied = eob.lines.find((l) => l.code === code && l.remarkCode);
      p.push(
        `The statement lists procedure code ${code} (${bill.lines.find((l) => l.code === code)?.description}) more than once on the same date. ` +
          `${eob.insurer.name} processed this claim${eob.processedDate ? ` on ${longDate(eob.processedDate)}` : ""}${eob.claimNumber ? ` (claim ${eob.claimNumber})` : ""}` +
          (denied?.remarkCode ? ` and denied the extra line with remark ${denied.remarkCode}: "${(eob.remarks[denied.remarkCode] ?? "").replace(/\.$/, "")}"` : " and only allowed it once") +
          `. I believe the duplicate charge of ${usd(f.amountAtIssue)} should be removed.`,
      );
    } else if (f.type === "billed_not_on_eob" || f.type === "amount_mismatch" || f.type === "payment_mismatch") {
      p.push(`${f.explanation} The amount in question is ${usd(f.amountAtIssue)}.`);
    }
  }
  p.push(
    `According to the Explanation of Benefits, my total responsibility for this claim is ${usd(rec.insurerSaysYouOwe)}. ` +
      `The statement shows an amount due of ${usd(rec.billAmountDue)}, a difference of ${usd(Math.max(0, rec.difference))}` +
      (facts.kind === "dispute" && Math.abs(facts.amountDisputed - rec.difference) < 0.005 ? ", which matches the charge above." : "."),
  );
  const asks =
    facts.kind === "dispute"
      ? [
          `Remove the incorrect charge of ${usd(facts.amountDisputed)}, or apply the insurer's adjustment.`,
          `Send a corrected statement showing a balance of ${usd(facts.expectedBalance)}.`,
          `Keep the disputed ${usd(facts.amountDisputed)} out of collections while you review this.`,
        ]
      : [
          `Explain how the amount due of ${usd(rec.billAmountDue)} was calculated.`,
          `If the balance should match the Explanation of Benefits, send a corrected statement showing ${usd(facts.expectedBalance)}.`,
        ];
  p.push(`Please:\n${asks.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  p.push("I have included copies of the statement and the Explanation of Benefits. Please reply to confirm you received this request.");
  p.push(`Sincerely,\n${bill.patientName || "The patient"}`);
  return p.join("\n\n");
}

export function verifyLetter(body: string, facts: LetterFacts, allowed: Set<string>): string[] {
  const problems: string[] = [];
  if (body.length > MAX_LETTER_CHARS) problems.push("Letter is too long.");
  for (const m of body.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)) {
    const v = cents(Number(m[1].replace(/,/g, ""))).toFixed(2);
    if (!allowed.has(v)) problems.push(`Amount $${m[1]} is not supported by the case evidence.`);
  }
  for (const t of facts.requiredTokens) if (!body.includes(t)) problems.push(`Missing required reference: ${t}`);
  // Known references (claim number) are fine; any other run of 9+ digits (even
  // with dashes or spaces) looks like a full account or member number.
  let scrubbed = body;
  for (const t of facts.requiredTokens) scrubbed = scrubbed.split(t).join(" ");
  for (const run of scrubbed.match(/\d[\d\- ]{7,}\d/g) ?? []) {
    if (run.replace(/\D/g, "").length >= 9) problems.push("Letter contains a long account-like number.");
  }
  for (const e of body.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
    if (e.toLowerCase() !== facts.recipient.email.toLowerCase()) problems.push(`Letter mentions an unapproved address: ${e}`);
  }
  return problems;
}
