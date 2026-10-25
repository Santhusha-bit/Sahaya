/**
 * Financial documents a bill investigation may read. Each document is stored in
 * Finance's own memory namespace with an explicit authorization flag; an
 * investigation only ever receives documents the person authorized for it.
 *
 * Documents keep their structured lines (so Finance can recompute every number
 * independently) plus a plain-text rendering that is attached to the Droid run.
 */

export type DocumentKind = "itemized_bill" | "insurance_eob";

export interface BillLine {
  lineId: string;
  serviceDate: string;
  code: string;
  description: string;
  quantity: number;
  /** Amount the provider charged for this line. */
  charge: number;
}

export interface EobLine {
  lineId: string;
  serviceDate: string;
  code: string;
  description: string;
  billed: number;
  allowed: number;
  planPaid: number;
  /** What the insurer says the patient owes for this line. */
  patientResponsibility: number;
  /** Insurer remark, e.g. a denial reason. */
  remark?: string;
}

export interface ItemizedBill {
  kind: "itemized_bill";
  documentId: string;
  title: string;
  provider: string;
  patient: string;
  accountNumber: string;
  statementDate: string;
  lines: BillLine[];
  insurancePaid: number;
  adjustments: number;
  amountDue: number;
}

export interface InsuranceEob {
  kind: "insurance_eob";
  documentId: string;
  title: string;
  insurer: string;
  plan: string;
  member: string;
  claimNumber: string;
  provider: string;
  networkStatus: "in_network" | "out_of_network";
  lines: EobLine[];
}

export type FinancialDocument = ItemizedBill | InsuranceEob;

const money = (n: number) => `$${n.toFixed(2)}`;

/** Plain-text rendering attached to the Droid run (what a person would see on paper). */
export function renderDocument(doc: FinancialDocument): string {
  if (doc.kind === "itemized_bill") {
    const rows = doc.lines.map(
      (l) => `${l.lineId}  ${l.serviceDate}  ${l.code.padEnd(6)} ${l.description.padEnd(44)} x${l.quantity}  ${money(l.charge)}`,
    );
    const total = doc.lines.reduce((s, l) => s + l.charge, 0);
    return [
      `${doc.provider.toUpperCase()}: ITEMIZED STATEMENT`,
      `Patient: ${doc.patient}    Account: ${doc.accountNumber}    Statement date: ${doc.statementDate}`,
      "",
      "LINE  DATE        CODE   DESCRIPTION                                  QTY CHARGE",
      ...rows,
      "",
      `Total charges:                ${money(total)}`,
      `Insurance payments:          -${money(doc.insurancePaid)}`,
      `Adjustments:                 -${money(doc.adjustments)}`,
      `AMOUNT DUE FROM PATIENT:      ${money(doc.amountDue)}`,
    ].join("\n");
  }
  const rows = doc.lines.map(
    (l) =>
      `${l.lineId}  ${l.serviceDate}  ${l.code.padEnd(6)} ${l.description.padEnd(36)} billed ${money(l.billed)}  allowed ${money(l.allowed)}  plan paid ${money(l.planPaid)}  you owe ${money(l.patientResponsibility)}${l.remark ? `  [${l.remark}]` : ""}`,
  );
  const owe = doc.lines.reduce((s, l) => s + l.patientResponsibility, 0);
  return [
    `${doc.insurer.toUpperCase()}: EXPLANATION OF BENEFITS (THIS IS NOT A BILL)`,
    `Plan: ${doc.plan}    Member: ${doc.member}    Claim: ${doc.claimNumber}`,
    `Provider: ${doc.provider} (${doc.networkStatus === "in_network" ? "in network" : "out of network"})`,
    "",
    ...rows,
    "",
    `TOTAL YOU MAY OWE THE PROVIDER: ${money(owe)}`,
    doc.networkStatus === "in_network"
      ? "In-network providers agreed not to bill you more than the amount shown as 'you owe'."
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The demo case: an emergency-room visit. The statement asks the patient for
 * $1,812.40, while the insurer's EOB says the patient owes $102.40. The gap
 * comes from a duplicated ER visit line, a supply line the insurer assigned to
 * provider liability, and balance billing by an in-network provider.
 */
export function sampleErBillDocuments(patient: string): FinancialDocument[] {
  const bill: ItemizedBill = {
    kind: "itemized_bill",
    documentId: "doc_bayview_statement",
    title: "Bayview General Hospital: itemized statement",
    provider: "Bayview General Hospital",
    patient,
    accountNumber: "BGH-****4471",
    statementDate: "2026-10-08",
    lines: [
      { lineId: "B1", serviceDate: "2026-09-12", code: "99284", description: "Emergency dept visit, level 4", quantity: 1, charge: 1450 },
      { lineId: "B2", serviceDate: "2026-09-12", code: "99284", description: "Emergency dept visit, level 4", quantity: 1, charge: 1450 },
      { lineId: "B3", serviceDate: "2026-09-12", code: "71046", description: "Chest X-ray, 2 views", quantity: 1, charge: 380 },
      { lineId: "B4", serviceDate: "2026-09-12", code: "85025", description: "Complete blood count (CBC)", quantity: 1, charge: 95 },
      { lineId: "B5", serviceDate: "2026-09-12", code: "80053", description: "Comprehensive metabolic panel", quantity: 1, charge: 210 },
      { lineId: "B6", serviceDate: "2026-09-12", code: "J1885", description: "Ketorolac injection, 15 mg", quantity: 1, charge: 85 },
      { lineId: "B7", serviceDate: "2026-09-12", code: "96374", description: "IV push, single drug", quantity: 1, charge: 420 },
      { lineId: "B8", serviceDate: "2026-09-12", code: "A9270", description: "Supplies, miscellaneous", quantity: 1, charge: 64 },
      { lineId: "B9", serviceDate: "2026-09-12", code: "93005", description: "Electrocardiogram (ECG) tracing", quantity: 1, charge: 240 },
    ],
    insurancePaid: 476.6,
    adjustments: 2105,
    amountDue: 1812.4,
  };
  const eob: InsuranceEob = {
    kind: "insurance_eob",
    documentId: "doc_goldenstate_eob",
    title: "Golden State Senior Advantage: Explanation of Benefits",
    insurer: "Golden State Health",
    plan: "Golden State Senior Advantage (HMO)",
    member: patient,
    claimNumber: "GS-2026-0918-55203",
    provider: "Bayview General Hospital",
    networkStatus: "in_network",
    lines: [
      { lineId: "E1", serviceDate: "2026-09-12", code: "99284", description: "Emergency dept visit, level 4", billed: 1450, allowed: 410, planPaid: 320, patientResponsibility: 90, remark: "ER copay" },
      { lineId: "E2", serviceDate: "2026-09-12", code: "99284", description: "Emergency dept visit, level 4", billed: 1450, allowed: 0, planPaid: 0, patientResponsibility: 0, remark: "Denied: duplicate of line E1. Not member responsibility" },
      { lineId: "E3", serviceDate: "2026-09-12", code: "71046", description: "Chest X-ray, 2 views", billed: 380, allowed: 62, planPaid: 49.6, patientResponsibility: 12.4, remark: "20% coinsurance" },
      { lineId: "E4", serviceDate: "2026-09-12", code: "85025", description: "Complete blood count (CBC)", billed: 95, allowed: 11, planPaid: 11, patientResponsibility: 0 },
      { lineId: "E5", serviceDate: "2026-09-12", code: "80053", description: "Comprehensive metabolic panel", billed: 210, allowed: 15, planPaid: 15, patientResponsibility: 0 },
      { lineId: "E6", serviceDate: "2026-09-12", code: "J1885", description: "Ketorolac injection, 15 mg", billed: 85, allowed: 4, planPaid: 4, patientResponsibility: 0 },
      { lineId: "E7", serviceDate: "2026-09-12", code: "96374", description: "IV push, single drug", billed: 420, allowed: 55, planPaid: 55, patientResponsibility: 0 },
      { lineId: "E8", serviceDate: "2026-09-12", code: "A9270", description: "Supplies, miscellaneous", billed: 64, allowed: 0, planPaid: 0, patientResponsibility: 0, remark: "Non-covered: provider liability. Member may not be billed" },
      { lineId: "E9", serviceDate: "2026-09-12", code: "93005", description: "Electrocardiogram (ECG) tracing", billed: 240, allowed: 22, planPaid: 22, patientResponsibility: 0 },
    ],
  };
  return [bill, eob];
}
