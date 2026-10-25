import { z } from "zod";
import { pickBillAndEob, reconcileBillWithEob } from "./analysis";
import type { FinancialDocument } from "./documents";

/** The structured report the investigation agent must return. */
export const findingSchema = z.object({
  title: z.string().min(1).max(160),
  category: z.enum(["duplicate_charge", "not_patient_responsibility", "balance_billing", "missing_from_eob", "pricing", "other"]),
  amount: z.number().min(0),
  lineIds: z.array(z.string()).default([]),
  evidence: z.string().min(1).max(600),
  calculation: z.string().max(400).default(""),
});

export const investigationReportSchema = z.object({
  summary: z.string().min(1).max(900),
  amountDueOnStatement: z.number().min(0),
  patientResponsibilityPerInsurer: z.number().min(0),
  estimatedOvercharge: z.number().min(0),
  findings: z.array(findingSchema).max(12),
  disputeRecommended: z.boolean(),
  recommendedNextSteps: z.array(z.string().max(300)).max(6).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

export type InvestigationFinding = z.infer<typeof findingSchema>;
export type InvestigationReport = z.infer<typeof investigationReportSchema>;

/** JSON Schema handed to the Droid SDK as its `outputFormat`. Kept in step with the Zod schema above. */
export const investigationReportJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Plain-language summary for an older adult, 2 to 4 sentences, no jargon." },
    amountDueOnStatement: { type: "number" },
    patientResponsibilityPerInsurer: { type: "number" },
    estimatedOvercharge: { type: "number", description: "Amount the statement asks for above what the insurer says is owed." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          category: {
            type: "string",
            enum: ["duplicate_charge", "not_patient_responsibility", "balance_billing", "missing_from_eob", "pricing", "other"],
          },
          amount: { type: "number" },
          lineIds: { type: "array", items: { type: "string" } },
          evidence: { type: "string", description: "Quote or cite the document lines that support this finding." },
          calculation: { type: "string", description: "The arithmetic, using results from the calculation tools." },
        },
        required: ["title", "category", "amount", "lineIds", "evidence", "calculation"],
        additionalProperties: false,
      },
    },
    disputeRecommended: { type: "boolean" },
    recommendedNextSteps: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "summary",
    "amountDueOnStatement",
    "patientResponsibilityPerInsurer",
    "estimatedOvercharge",
    "findings",
    "disputeRecommended",
    "recommendedNextSteps",
    "confidence",
  ],
  additionalProperties: false,
} as const;

export interface VerificationCheck {
  label: string;
  reported: number;
  recomputed: number;
  ok: boolean;
}

export interface Verification {
  verified: boolean;
  checks: VerificationCheck[];
  /** Line ids the report cites that do not exist in the authorized documents. */
  unknownLineIds: string[];
  /** The amount Finance will use for any dispute: always Finance's own number. */
  verifiedOvercharge: number;
  notes: string[];
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.01;

/**
 * Finance does not take the investigation's numbers on trust: it recomputes the
 * headline figures from the authorized documents and checks every cited line.
 */
export function verifyReport(report: InvestigationReport, docs: FinancialDocument[]): Verification {
  const { bill, eob } = pickBillAndEob(docs);
  const notes: string[] = [];
  if (!bill || !eob) {
    return {
      verified: false,
      checks: [],
      unknownLineIds: [],
      verifiedOvercharge: 0,
      notes: ["A statement and an insurer EOB are both needed to verify the figures."],
    };
  }
  const rec = reconcileBillWithEob(bill, eob);
  const checks: VerificationCheck[] = [
    { label: "Amount due on statement", reported: report.amountDueOnStatement, recomputed: rec.amountDueOnStatement },
    { label: "Patient responsibility per insurer", reported: report.patientResponsibilityPerInsurer, recomputed: rec.patientResponsibilityPerEob },
    { label: "Estimated overcharge", reported: report.estimatedOvercharge, recomputed: rec.excessBilled },
  ].map((c) => ({ ...c, ok: close(c.reported, c.recomputed) }));

  const knownLineIds = new Set(docs.flatMap((d) => d.lines.map((l) => l.lineId)));
  const unknownLineIds = [...new Set(report.findings.flatMap((f) => f.lineIds).filter((id) => !knownLineIds.has(id)))];
  if (unknownLineIds.length) notes.push(`Report cites lines that are not in the documents: ${unknownLineIds.join(", ")}.`);
  for (const c of checks) if (!c.ok) notes.push(`${c.label}: report says $${c.reported.toFixed(2)}, Finance recomputed $${c.recomputed.toFixed(2)}.`);
  if (report.disputeRecommended && rec.excessBilled <= 0) notes.push("A dispute was recommended, but Finance found no amount above what the insurer says is owed.");

  return {
    verified: checks.every((c) => c.ok) && unknownLineIds.length === 0,
    checks,
    unknownLineIds,
    verifiedOvercharge: rec.excessBilled,
    notes,
  };
}
