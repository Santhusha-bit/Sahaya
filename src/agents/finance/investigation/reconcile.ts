/**
 * Deterministic bill-vs-EOB reconciliation. Pure functions, no I/O, no model.
 * This is the authority on every number in a case: Claude may phrase or
 * corroborate, but findings, amounts and the expected balance come from here.
 */

import { cents } from "./extract";
import type { BillLine, Calculation, CheckResult, EobLine, Evidence, ExtractedBill, ExtractedEob, Finding, Reconciliation } from "./types";

const usd = (n: number) => `$${n.toFixed(2)}`;
const EPS = 0.005;

function billEvidence(bill: ExtractedBill, sha: string, l: BillLine): Evidence {
  return { doc: "bill", docSha256: sha, lineId: l.lineId, quote: l.sourceText };
}
function eobEvidence(sha: string, l: EobLine): Evidence {
  return { doc: "eob", docSha256: sha, lineId: l.lineId, quote: l.sourceText };
}

function isDuplicateDenial(l: EobLine, remarks: Record<string, string>): boolean {
  const text = l.remarkCode ? remarks[l.remarkCode] ?? "" : "";
  return l.allowed === 0 && l.patientResp === 0 && /duplicate/i.test(text);
}

export function reconcile(
  bill: ExtractedBill,
  eob: ExtractedEob,
  hashes: { bill: string; eob: string },
): Reconciliation {
  const findings: Finding[] = [];
  const checks: CheckResult[] = [];
  let n = 0;
  const fid = () => `F${++n}`;
  const add = (f: Omit<Finding, "findingId" | "source" | "review">) => {
    const finding: Finding = { ...f, findingId: fid(), source: "rules", review: "pending" };
    findings.push(finding);
    return finding;
  };

  /* ---- 1. internal arithmetic on each document ---- */
  const lineSum = cents(bill.lines.reduce((s, l) => s + l.amount, 0));
  const chargesOk = Math.abs(lineSum - bill.totals.charges) < EPS;
  checks.push({ check: "Statement lines add up to total charges", passed: chargesOk, detail: `${bill.lines.map((l) => l.amount.toFixed(2)).join(" + ")} = ${usd(lineSum)} vs ${usd(bill.totals.charges)}` });
  const dueCalc = cents(bill.totals.charges - bill.totals.insurancePaid - bill.totals.adjustments);
  const dueOk = Math.abs(dueCalc - bill.totals.amountDue) < EPS;
  checks.push({ check: "Statement balance follows from its own totals", passed: dueOk, detail: `${usd(bill.totals.charges)} - ${usd(bill.totals.insurancePaid)} - ${usd(bill.totals.adjustments)} = ${usd(dueCalc)} vs ${usd(bill.totals.amountDue)}` });
  if (!chargesOk || !dueOk) {
    add({
      type: "bill_arithmetic",
      severity: "medium",
      title: "The statement's own numbers don't add up",
      explanation: "The line items or totals on the statement are inconsistent with each other.",
      amountAtIssue: cents(Math.max(0, bill.totals.amountDue - dueCalc)),
      evidence: [],
      calculations: [
        { label: "Sum of statement lines", expression: bill.lines.map((l) => l.amount.toFixed(2)).join(" + "), result: lineSum },
        { label: "Balance from statement totals", expression: `${bill.totals.charges.toFixed(2)} - ${bill.totals.insurancePaid.toFixed(2)} - ${bill.totals.adjustments.toFixed(2)}`, result: dueCalc },
      ],
    });
  }
  const eobRespSum = cents(eob.lines.reduce((s, l) => s + l.patientResp, 0));
  checks.push({ check: "EOB line responsibilities add up to its total", passed: Math.abs(eobRespSum - eob.totals.patientResp) < EPS, detail: `${usd(eobRespSum)} vs ${usd(eob.totals.patientResp)}` });
  const lineMath = eob.lines.filter((l) => l.allowed > 0).every((l) => Math.abs(l.planPaid + l.patientResp - l.allowed) < EPS);
  checks.push({ check: "On every EOB line, plan paid + you owe = allowed", passed: lineMath, detail: lineMath ? "All covered lines balance." : "At least one EOB line does not balance." });

  /* ---- 2. identity checks between the documents ---- */
  const sameClaim = !bill.claimNumber || !eob.claimNumber || bill.claimNumber === eob.claimNumber;
  checks.push({ check: "Both documents refer to the same claim", passed: sameClaim, detail: `${bill.claimNumber ?? "(not on statement)"} / ${eob.claimNumber ?? "(not on EOB)"}` });
  const samePatient = !bill.patientName || !eob.memberName || bill.patientName.toLowerCase() === eob.memberName.toLowerCase();
  checks.push({ check: "Patient on the statement matches the member on the EOB", passed: samePatient, detail: `${bill.patientName} / ${eob.memberName}` });

  /* ---- 3. line matching by (date, code) ---- */
  const key = (d: string, c: string) => `${d}|${c}`;
  const billGroups = new Map<string, BillLine[]>();
  for (const l of bill.lines) billGroups.set(key(l.serviceDate, l.code), [...(billGroups.get(key(l.serviceDate, l.code)) ?? []), l]);
  const eobGroups = new Map<string, EobLine[]>();
  for (const l of eob.lines) eobGroups.set(key(l.serviceDate, l.code), [...(eobGroups.get(key(l.serviceDate, l.code)) ?? []), l]);

  const duplicates: Finding[] = [];
  for (const [k, bLines] of billGroups) {
    const eLines = eobGroups.get(k) ?? [];
    const [date, code] = k.split("|");
    if (!eLines.length) {
      const amt = cents(bLines.reduce((s, l) => s + l.amount, 0));
      add({
        type: "billed_not_on_eob",
        severity: "medium",
        title: `${code} was billed but never sent to insurance`,
        explanation: `The statement charges for ${bLines[0].description} (${code}) on ${date}, but the EOB has no matching line. It may not have been submitted to the insurer.`,
        amountAtIssue: amt,
        evidence: bLines.map((l) => billEvidence(bill, hashes.bill, l)),
        calculations: [{ label: "Charges with no EOB line", expression: bLines.map((l) => l.amount.toFixed(2)).join(" + "), result: amt }],
      });
      continue;
    }
    const denied = eLines.filter((l) => isDuplicateDenial(l, eob.remarks));
    if (bLines.length > 1 && (denied.length > 0 || eLines.length < bLines.length)) {
      const extraCount = denied.length || bLines.length - eLines.length;
      const extra = bLines.slice(bLines.length - extraCount);
      const amt = cents(extra.reduce((s, l) => s + l.amount, 0));
      const remark = denied[0]?.remarkCode;
      const f = add({
        type: "duplicate_charge",
        severity: "high",
        title: `Possible duplicate charge: ${bLines[0].description} (${code})`,
        explanation:
          `The statement lists ${code} ${bLines.length} times on ${date}. ` +
          (denied.length
            ? `The insurer denied ${denied.length === 1 ? "the extra line" : "the extra lines"} as a duplicate (remark ${remark}: "${eob.remarks[remark!]}").`
            : `The insurer only processed it ${eLines.length} time(s).`) +
          ` The statement does not show that the ${usd(amt)} was written off.`,
        amountAtIssue: amt,
        evidence: [...bLines.map((l) => billEvidence(bill, hashes.bill, l)), ...eLines.map((l) => eobEvidence(hashes.eob, l))],
        calculations: [
          { label: `Times ${code} was billed on ${date}`, expression: `${bLines.length} lines on the statement`, result: bLines.length },
          { label: "Times the insurer allowed it", expression: `${eLines.length - denied.length} of ${eLines.length} EOB lines`, result: eLines.length - denied.length },
          { label: "Duplicate amount", expression: extra.map((l) => l.amount.toFixed(2)).join(" + "), result: amt },
        ],
      });
      duplicates.push(f);
    }
    // Billed amount must match what the insurer saw, line for line.
    const bSorted = [...bLines].map((l) => l.amount).sort((a, b) => a - b);
    const eSorted = [...eLines].map((l) => l.billed).sort((a, b) => a - b);
    if (bSorted.length === eSorted.length && bSorted.some((a, i) => Math.abs(a - eSorted[i]) > EPS)) {
      const diff = cents(bSorted.reduce((s, a) => s + a, 0) - eSorted.reduce((s, a) => s + a, 0));
      add({
        type: "amount_mismatch",
        severity: "medium",
        title: `${code} was billed at a different amount than the insurer saw`,
        explanation: `The statement charges ${bSorted.map(usd).join(", ")} for ${code}; the EOB shows ${eSorted.map(usd).join(", ")} billed.`,
        amountAtIssue: Math.max(0, diff),
        evidence: [...bLines.map((l) => billEvidence(bill, hashes.bill, l)), ...eLines.map((l) => eobEvidence(hashes.eob, l))],
        calculations: [{ label: "Statement minus EOB billed", expression: `${bSorted.join(" + ")} - (${eSorted.join(" + ")})`, result: diff }],
      });
    }
  }

  /* ---- 4. payments and the bottom line ---- */
  const paidOk = Math.abs(bill.totals.insurancePaid - eob.totals.planPaid) < EPS;
  checks.push({ check: "Insurance payment on the statement matches what the plan paid", passed: paidOk, detail: `${usd(bill.totals.insurancePaid)} vs ${usd(eob.totals.planPaid)}` });
  if (!paidOk) {
    const diff = cents(eob.totals.planPaid - bill.totals.insurancePaid);
    add({
      type: "payment_mismatch",
      severity: "medium",
      title: "The insurance payment on the statement differs from the EOB",
      explanation: `The EOB says the plan paid ${usd(eob.totals.planPaid)}; the statement credits ${usd(bill.totals.insurancePaid)}.`,
      amountAtIssue: Math.max(0, diff),
      evidence: [],
      calculations: [{ label: "Plan paid minus statement credit", expression: `${eob.totals.planPaid.toFixed(2)} - ${bill.totals.insurancePaid.toFixed(2)}`, result: diff }],
    });
  }

  const difference = cents(bill.totals.amountDue - eob.totals.patientResp);
  const balanceOk = Math.abs(difference) < EPS;
  checks.push({ check: "Amount due matches what the EOB says you owe", passed: balanceOk, detail: `${usd(bill.totals.amountDue)} vs ${usd(eob.totals.patientResp)}` });
  if (difference > EPS) {
    const explained = findings.filter((f) => f.type !== "bill_arithmetic");
    const explainedSum = cents(explained.reduce((s, f) => s + f.amountAtIssue, 0));
    const calcs: Calculation[] = [
      { label: "Statement amount due", expression: "from the statement", result: bill.totals.amountDue },
      { label: "EOB: your total responsibility", expression: "from the EOB", result: eob.totals.patientResp },
      { label: "Difference", expression: `${bill.totals.amountDue.toFixed(2)} - ${eob.totals.patientResp.toFixed(2)}`, result: difference },
      { label: "Write-off the statement should show", expression: `${eob.totals.billed.toFixed(2)} billed - ${eob.totals.allowed.toFixed(2)} allowed`, result: cents(eob.totals.billed - eob.totals.allowed) },
      { label: "Adjustment the statement actually shows", expression: "from the statement", result: bill.totals.adjustments },
    ];
    const f = add({
      type: "balance_mismatch",
      severity: "high",
      title: `You're billed ${usd(difference)} more than insurance says you owe`,
      explanation:
        `The statement asks for ${usd(bill.totals.amountDue)}, but the EOB says your total responsibility is ${usd(eob.totals.patientResp)}.` +
        (explained.length && Math.abs(explainedSum - difference) < EPS ? ` The gap is fully explained by ${explained.map((e) => e.findingId).join(", ")}.` : ""),
      amountAtIssue: difference,
      evidence: [],
      calculations: calcs,
    });
    if (explained.length && Math.abs(explainedSum - difference) < EPS) f.explainedBy = explained.map((e) => e.findingId).join(",");
  }

  const nextSteps: string[] = [];
  if (findings.length) {
    nextSteps.push(`Ask ${bill.provider.name} billing to correct the statement to ${usd(eob.totals.patientResp)}${duplicates.length ? ", removing the duplicate charge" : ""}.`);
    nextSteps.push(`Hold the disputed ${usd(Math.max(difference, 0))} until a corrected statement arrives. The undisputed ${usd(eob.totals.patientResp)} can be paid by the due date.`);
    nextSteps.push(`If there's no fix within 30 days, call ${eob.insurer.name}${eob.insurer.phone ? ` at ${eob.insurer.phone}` : ""} with claim ${eob.claimNumber ?? "number from the EOB"}.`);
  }

  return { findings, checks, billAmountDue: bill.totals.amountDue, insurerSaysYouOwe: eob.totals.patientResp, difference, nextSteps };
}

/** Amounts that may legitimately appear in anything Finance writes about this case. */
export function allowedAmounts(bill: ExtractedBill, eob: ExtractedEob, rec: Reconciliation): Set<string> {
  const s = new Set<string>();
  const put = (x: number) => s.add(cents(x).toFixed(2));
  bill.lines.forEach((l) => put(l.amount));
  eob.lines.forEach((l) => [l.billed, l.allowed, l.planPaid, l.patientResp].forEach(put));
  Object.values(bill.totals).forEach(put);
  Object.values(eob.totals).forEach(put);
  rec.findings.forEach((f) => {
    put(f.amountAtIssue);
    f.calculations.forEach((c) => put(c.result));
  });
  put(rec.difference);
  return s;
}
