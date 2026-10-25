import type { BillLine, FinancialDocument, InsuranceEob, ItemizedBill } from "./documents";

/**
 * Deterministic bill calculations. These are the ONLY calculations the Droid is
 * permitted to run (exposed to it as read-only tools), and Finance re-runs the
 * same functions afterwards to verify the Droid's report independently.
 * All arithmetic is done in integer cents.
 */

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => Number((c / 100).toFixed(2));

export function sumAmounts(amounts: number[]): number {
  return dollars(amounts.reduce((s, a) => s + cents(a), 0));
}

export interface DuplicateGroup {
  code: string;
  serviceDate: string;
  lineIds: string[];
  chargeEach: number;
  /** Charges beyond the first occurrence. */
  extraCharged: number;
}

export function findDuplicateCharges(bill: ItemizedBill): DuplicateGroup[] {
  const groups = new Map<string, BillLine[]>();
  for (const l of bill.lines) {
    const key = `${l.code}|${l.serviceDate}|${cents(l.charge)}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      code: g[0].code,
      serviceDate: g[0].serviceDate,
      lineIds: g.map((l) => l.lineId),
      chargeEach: g[0].charge,
      extraCharged: dollars(cents(g[0].charge) * (g.length - 1)),
    }));
}

export interface ReconciledLine {
  billLineId: string;
  eobLineId: string | null;
  code: string;
  description: string;
  charge: number;
  allowed: number | null;
  planPaid: number | null;
  patientResponsibility: number | null;
  remark?: string;
  /** Insurer says the member may not be billed for this line. */
  notPatientResponsibility: boolean;
}

export interface Reconciliation {
  lines: ReconciledLine[];
  billLinesMissingFromEob: string[];
  totalCharges: number;
  insurancePaidOnBill: number;
  planPaidOnEob: number;
  amountDueOnStatement: number;
  patientResponsibilityPerEob: number;
  /** Amount the statement asks for above what the insurer says is owed. */
  excessBilled: number;
  inNetwork: boolean;
  /** Charges on lines the insurer marked as not the member's responsibility. */
  deniedNotMemberResponsibility: number;
}

/**
 * Match each statement line to an EOB line (same code + date, one-to-one in
 * order) and compare what the statement asks for against what the insurer says
 * the patient owes.
 */
export function reconcileBillWithEob(bill: ItemizedBill, eob: InsuranceEob): Reconciliation {
  const unused = [...eob.lines];
  const lines: ReconciledLine[] = bill.lines.map((b) => {
    const idx = unused.findIndex((e) => e.code === b.code && e.serviceDate === b.serviceDate);
    const e = idx >= 0 ? unused.splice(idx, 1)[0] : null;
    const remark = e?.remark;
    return {
      billLineId: b.lineId,
      eobLineId: e?.lineId ?? null,
      code: b.code,
      description: b.description,
      charge: b.charge,
      allowed: e?.allowed ?? null,
      planPaid: e?.planPaid ?? null,
      patientResponsibility: e?.patientResponsibility ?? null,
      remark,
      notPatientResponsibility: !!remark && /not member responsibility|may not be billed|provider liability/i.test(remark),
    };
  });
  const patientResponsibilityPerEob = sumAmounts(eob.lines.map((l) => l.patientResponsibility));
  return {
    lines,
    billLinesMissingFromEob: lines.filter((l) => !l.eobLineId).map((l) => l.billLineId),
    totalCharges: sumAmounts(bill.lines.map((l) => l.charge)),
    insurancePaidOnBill: bill.insurancePaid,
    planPaidOnEob: sumAmounts(eob.lines.map((l) => l.planPaid)),
    amountDueOnStatement: bill.amountDue,
    patientResponsibilityPerEob,
    excessBilled: dollars(Math.max(0, cents(bill.amountDue) - cents(patientResponsibilityPerEob))),
    inNetwork: eob.networkStatus === "in_network",
    deniedNotMemberResponsibility: sumAmounts(lines.filter((l) => l.notPatientResponsibility).map((l) => l.charge)),
  };
}

export function pickBillAndEob(docs: FinancialDocument[]): { bill?: ItemizedBill; eob?: InsuranceEob } {
  return {
    bill: docs.find((d): d is ItemizedBill => d.kind === "itemized_bill"),
    eob: docs.find((d): d is InsuranceEob => d.kind === "insurance_eob"),
  };
}
