/**
 * Types for the Finance bill investigation (Hyphenate: autonomous systems for
 * finance). One investigation = one case: two source documents, the facts
 * extracted from them, deterministic findings with evidence and calculations,
 * a draft request, a human decision, and the submission's progress. Every step
 * is appended to a hash-chained case audit trail.
 */

export type DocKind = "bill" | "eob";

export interface SourceDocument {
  docId: string;
  kind: DocKind;
  fileName: string;
  /** SHA-256 of the exact text Finance read. Evidence is tied to this hash. */
  sha256: string;
  text: string;
  uploadedAt: number;
}

export interface BillLine {
  lineId: string;
  serviceDate: string; // YYYY-MM-DD
  code: string;
  description: string;
  amount: number;
  /** The exact line of the source document this was read from. */
  sourceText: string;
}

export interface EobLine {
  lineId: string;
  serviceDate: string;
  code: string;
  description: string;
  billed: number;
  allowed: number;
  planPaid: number;
  patientResp: number;
  remarkCode?: string;
  sourceText: string;
}

export interface ExtractedBill {
  kind: "bill";
  docId: string;
  provider: { name: string; billingEmail?: string; phone?: string };
  patientName: string;
  /** Masked to the last four digits; the full number is never stored. */
  accountLast4?: string;
  statementDate?: string;
  claimNumber?: string;
  lines: BillLine[];
  totals: { charges: number; insurancePaid: number; adjustments: number; amountDue: number };
  extractedBy: "parser" | "claude";
}

export interface ExtractedEob {
  kind: "eob";
  docId: string;
  insurer: { name: string; phone?: string };
  memberName: string;
  claimNumber?: string;
  providerName?: string;
  processedDate?: string;
  lines: EobLine[];
  totals: { billed: number; allowed: number; planPaid: number; patientResp: number };
  remarks: Record<string, string>;
  extractedBy: "parser" | "claude";
}

export interface Calculation {
  label: string;
  expression: string;
  result: number;
}

export interface Evidence {
  doc: DocKind;
  docSha256: string;
  lineId?: string;
  quote: string;
}

export type FindingType =
  | "duplicate_charge"
  | "balance_mismatch"
  | "billed_not_on_eob"
  | "amount_mismatch"
  | "payment_mismatch"
  | "bill_arithmetic";

export interface Finding {
  findingId: string;
  type: FindingType;
  severity: "high" | "medium" | "low";
  title: string;
  explanation: string;
  /** Dollars the person may be overcharged because of this finding. */
  amountAtIssue: number;
  evidence: Evidence[];
  calculations: Calculation[];
  /** "rules" = found by the deterministic engine; "rules+claude" = Claude independently flagged it too. */
  source: "rules" | "rules+claude";
  /** Set when another finding fully accounts for this one (e.g. balance gap explained by a duplicate). */
  explainedBy?: string;
  review: "pending" | "confirmed" | "dismissed";
  reviewNote?: string;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

export interface Reconciliation {
  findings: Finding[];
  checks: CheckResult[];
  billAmountDue: number;
  insurerSaysYouOwe: number;
  /** billAmountDue - insurerSaysYouOwe (positive = billed more than the EOB says you owe). */
  difference: number;
  nextSteps: string[];
}

/** Advisory output from the analyst (Claude when live). Never decides amounts. */
export interface AnalystObservation {
  type: string;
  lineIds: string[];
  note: string;
  corroborated: boolean;
}

export interface DisputeDraft {
  version: number;
  kind: "dispute" | "clarification";
  recipient: { name: string; email: string };
  subject: string;
  body: string;
  findingIds: string[];
  amountDisputed: number;
  expectedBalance: number;
  /** Fingerprint of recipient + subject + body + findings. Approval is bound to it. */
  draftHash: string;
  draftedBy: "template" | "claude";
  createdAt: number;
}

export type CaseStatus =
  | "awaiting_review"
  | "no_issues_found"
  | "submitted"
  | "acknowledged"
  | "under_review"
  | "resolved"
  | "partially_resolved"
  | "closed_no_action";

export type CaseActorKind = "finance-agent" | "reviewer" | "billing-office" | "system";

export interface CaseActor {
  kind: CaseActorKind;
  id: string;
}

export interface ChainEvent {
  seq: number;
  at: number;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface SubmissionRecord {
  submissionRef: string;
  submittedAt: number;
  channel: "sandbox";
  approvalId: string;
  approvedBy: string;
  draftHash: string;
  recipientEmail: string;
}

export interface ProviderUpdate {
  stage: "submitted" | "acknowledged" | "under_review" | "resolved";
  label: string;
  at: number;
  providerRef?: string;
  message?: string;
  correctedBalance?: number;
}

export interface ResolutionCheck {
  expectedBalance: number;
  correctedBalance: number;
  matches: boolean;
  detail: string;
}

export interface InvestigationCase {
  caseId: string;
  status: CaseStatus;
  title: string;
  patientName: string;
  documents: { docId: string; kind: DocKind; fileName: string; sha256: string }[];
  bill: ExtractedBill;
  eob: ExtractedEob;
  reconciliation: Reconciliation;
  summary: string;
  summaryBy: "template" | "claude";
  observations: AnalystObservation[];
  /** Content in the documents Finance deliberately ignored (e.g. embedded instructions). */
  warnings: string[];
  draft: DisputeDraft | null;
  submission: SubmissionRecord | null;
  updates: ProviderUpdate[];
  resolution: ResolutionCheck | null;
  chain: ChainEvent[];
  createdAt: number;
  updatedAt: number;
}
