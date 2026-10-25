import { z } from "zod";
import { notYetImplemented } from "../base/scaffold";
import { defineTool, type AnyTool } from "../base/ToolRegistry";

const owner = "finance" as const;
const M2 = "M2";

export const FINANCE_NAMESPACES = [
  "finance.records",
  "finance.bills",
  "finance.invoiceAnalyses",
  "finance.disputes",
  "finance.approvals",
];

const lineItem = z.object({
  description: z.string().min(1).max(200),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  code: z.string().max(20).optional().describe("CPT/HCPCS or facility code if shown"),
  amountCents: z.number().int(),
});

export const financeTools: AnyTool[] = [
  defineTool({
    name: "analyzeMedicalBill",
    owner,
    description: "Analyze a medical bill's line items for duplicates, unusual amounts, and items worth questioning; saves the analysis.",
    input: z.object({
      provider: z.string().min(1).max(200),
      statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      lineItems: z.array(lineItem).min(1).max(200),
      amountDueCents: z.number().int().min(0),
    }),
    risk: "write",
    handler: notYetImplemented("analyzeMedicalBill", M2),
  }),
  defineTool({
    name: "compareInsuranceDocuments",
    owner,
    description: "Compare a bill against the insurer's Explanation of Benefits to find mismatches in what the patient owes.",
    input: z.object({
      billId: z.string().min(1).max(64),
      eob: z.object({
        insurer: z.string().min(1).max(200),
        patientResponsibilityCents: z.number().int().min(0),
        lines: z.array(lineItem.extend({ allowedCents: z.number().int().min(0).optional() })).max(200),
      }),
    }),
    risk: "read",
    handler: notYetImplemented("compareInsuranceDocuments", M2),
  }),
  defineTool({
    name: "auditCareFacilityInvoice",
    owner,
    description: "Audit a care-facility (assisted living, home care) invoice against the agreed rate sheet.",
    input: z.object({
      facility: z.string().min(1).max(200),
      period: z.string().regex(/^\d{4}-\d{2}$/).describe("YYYY-MM"),
      lineItems: z.array(lineItem).min(1).max(200),
      agreedMonthlyRateCents: z.number().int().min(0).optional(),
    }),
    risk: "write",
    handler: notYetImplemented("auditCareFacilityInvoice", M2),
  }),
  defineTool({
    name: "detectRecurringCharges",
    owner,
    description: "Find recurring charges and subscriptions in authorized transaction history.",
    input: z.object({
      lookbackDays: z.number().int().min(30).max(400).default(120),
    }),
    risk: "read",
    handler: notYetImplemented("detectRecurringCharges", M2),
  }),
  defineTool({
    name: "analyzeAuthorizedTransactions",
    owner,
    description: "Review authorized transactions for unusual or potentially fraudulent activity.",
    input: z.object({
      lookbackDays: z.number().int().min(1).max(90).default(30),
    }),
    risk: "read",
    handler: notYetImplemented("analyzeAuthorizedTransactions", M2),
  }),
  defineTool({
    name: "prepareDispute",
    owner,
    description: "Draft a dispute or appeal letter for a bill or charge. Submitting it requires the user's approval.",
    input: z.object({
      subjectId: z.string().min(1).max(64).describe("Bill, invoice, or transaction id"),
      reason: z.string().min(10).max(1000),
      disputedAmountCents: z.number().int().positive(),
      recipient: z.string().min(1).max(200),
    }),
    risk: "sensitive",
    summarize: (i) => `Send dispute to ${i.recipient} for $${(i.disputedAmountCents / 100).toFixed(2)}`,
    handler: notYetImplemented("prepareDispute", M2),
  }),
  defineTool({
    name: "requestFinancialApproval",
    owner,
    description: "Request the user's approval for a payment (e.g. a grocery order Care asked Finance to review).",
    input: z.object({
      payee: z.string().min(1).max(200),
      amountCents: z.number().int().positive(),
      purpose: z.string().min(3).max(300),
      reference: z.string().max(64).optional(),
    }),
    risk: "sensitive",
    summarize: (i) => `Pay ${i.payee} $${(i.amountCents / 100).toFixed(2)} — ${i.purpose}`,
    handler: notYetImplemented("requestFinancialApproval", M2),
  }),
  defineTool({
    name: "searchBenefits",
    owner,
    description: "Search for public and private benefits the user may qualify for (e.g. Medicare Savings Programs, LIHEAP, SNAP).",
    input: z.object({
      state: z.string().length(2).describe("US state code"),
      monthlyIncomeCents: z.number().int().min(0).optional(),
      categories: z.array(z.enum(["healthcare", "food", "utilities", "housing", "prescriptions", "transportation"])).max(6).optional(),
    }),
    risk: "read",
    integrations: ["benefits"],
    handler: notYetImplemented("searchBenefits", M2),
  }),
  defineTool({
    name: "generateCareCostProjection",
    owner,
    description: "Project future care costs over a number of months under different care scenarios.",
    input: z.object({
      months: z.number().int().min(1).max(120),
      scenarios: z.array(z.enum(["current", "home_care_part_time", "home_care_full_time", "assisted_living", "memory_care"])).min(1).max(5),
      annualInflationPct: z.number().min(0).max(15).default(4),
    }),
    risk: "read",
    handler: notYetImplemented("generateCareCostProjection", M2),
  }),
  defineTool({
    name: "flagSuspiciousCharge",
    owner,
    description:
      "Alert the Guardian agent about a charge that may be fraud. Shares only merchant, amount, reason and a reference; requires the user's cross-agent permission.",
    input: z.object({
      merchant: z.string().min(1).max(100),
      amountCents: z.number().int().positive(),
      reason: z.string().min(5).max(500),
      transactionRef: z.string().max(64),
    }),
    risk: "write",
    handler: notYetImplemented("flagSuspiciousCharge", "M3"),
  }),
];
