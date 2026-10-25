import { z } from "zod";
import type { AgentTool } from "../base/types";
import { getDisputeChannel } from "@/integrations/billingOffice";
import { caseSnapshot, openInvestigation, SUBMIT_TOOL, submitApprovedDraft, trackCase } from "./investigation/caseService";
import { sampleDocuments } from "./investigation/samples";

/**
 * Finance's bill-investigation tools. Deliberately absent: any tool to review
 * findings, approve a draft, change a recipient, or pay. Those belong to the
 * person (via the approval gate and the /finance/case screen), not the agent.
 */

const usd = (n: number) => `$${n.toFixed(2)}`;

export const investigationTools: AgentTool[] = [
  {
    name: "openBillInvestigation",
    description:
      "Investigate a medical bill against the insurer's Explanation of Benefits (EOB): extract charges, compare the documents, flag discrepancies such as duplicate charges with evidence and calculations, and prepare a dispute draft for the person's approval. Does not send anything.",
    inputSchema: z.object({
      useSampleDocuments: z.boolean().default(false).describe("Use Margaret's sample hospital statement and EOB."),
      documents: z
        .array(z.object({ fileName: z.string().min(1).max(120), text: z.string().min(1).max(60_000) }))
        .max(2)
        .optional()
        .describe("Exactly two uploaded documents: the bill and the EOB, as text."),
    }),
    async execute(input, ctx) {
      const documents = input.documents?.length ? input.documents : input.useSampleDocuments ? sampleDocuments() : null;
      if (!documents) {
        return { ok: false, summary: "Please upload the bill and the insurance EOB on the bill-check screen, and I'll compare them.", error: "no_documents" };
      }
      const res = await openInvestigation(ctx, { documents });
      if (!res.ok) return { ok: false, summary: res.errors[0], error: res.errors.join(" ") };
      const c = res.case;
      const r = c.reconciliation;
      const top = r.findings.find((f) => f.type === "duplicate_charge") ?? r.findings[0];
      return {
        ok: true,
        summary: r.findings.length
          ? `I compared the ${c.bill.provider.name} statement with the ${c.eob.insurer.name} EOB. The bill asks for ${usd(r.billAmountDue)}; insurance says you owe ${usd(r.insurerSaysYouOwe)}. ${top.title}. I drafted a letter to the billing office, and it will only be sent if you approve it.`
          : `I compared both documents and they agree: you owe ${usd(r.insurerSaysYouOwe)}. Nothing to dispute.`,
        data: { caseId: res.caseId, status: c.status, findings: r.findings.map((f) => ({ id: f.findingId, title: f.title, amount: f.amountAtIssue })), approvalId: res.approvalId },
        approvalId: res.approvalId,
      };
    },
  },
  {
    name: "getBillInvestigation",
    description: "Report the status of the latest (or a given) bill investigation: findings, draft, and where the dispute stands.",
    inputSchema: z.object({ caseId: z.string().optional() }),
    async execute(input, ctx) {
      const snap = await caseSnapshot(ctx, input.caseId);
      if (!snap.case) return { ok: false, summary: "There's no bill investigation yet.", error: "no_case" };
      const c = snap.case;
      return {
        ok: true,
        summary: `${c.title}: ${c.status.replace(/_/g, " ")}. ${c.reconciliation.findings.length} finding(s); audit trail ${snap.chain?.ok ? "verified" : "FAILED verification"} (${c.chain.length} entries).`,
        data: { caseId: c.caseId, status: c.status, approvalPending: !!snap.approval, chain: snap.chain },
      };
    },
  },
  {
    name: SUBMIT_TOOL,
    description:
      "Send the approved dispute or clarification letter to the provider's billing office. Requires the person's approval of that exact letter (bound to its fingerprint); refuses if the letter, recipient or case changed.",
    inputSchema: z.object({ caseId: z.string().min(1), draftHash: z.string().min(8), recipientEmail: z.string().email() }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: "Send billing letter",
      description: `Send letter ${input.draftHash} to ${input.recipientEmail}.`,
    }),
    async execute(input, ctx) {
      const res = await submitApprovedDraft(ctx, input, getDisputeChannel());
      if (!res.ok) return { ok: false, summary: res.message, error: res.refusal };
      await ctx.tasks.create({
        title: `Billing dispute: ${res.case.bill.provider.name}`,
        description: `Ref ${res.submissionRef}. Expecting a corrected balance of ${usd(res.case.draft!.expectedBalance)}.`,
        steps: ["Approved", "Sent", "Acknowledged", "Reviewed", "Resolved"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      return {
        ok: true,
        summary: `Sent to ${res.case.draft!.recipient.name} (sandbox billing office), reference ${res.submissionRef}. I'll keep track and check that the corrected balance is ${usd(res.case.draft!.expectedBalance)}.`,
        data: { caseId: res.case.caseId, submissionRef: res.submissionRef },
      };
    },
  },
  {
    name: "trackDisputeCase",
    description: "Check for responses from the billing office on a submitted dispute and verify any corrected balance against what insurance says is owed.",
    inputSchema: z.object({ caseId: z.string().optional() }),
    async execute(input, ctx) {
      const c = await trackCase(ctx, getDisputeChannel(), input.caseId);
      if (!c) return { ok: false, summary: "There's no bill investigation yet.", error: "no_case" };
      if (!c.submission) return { ok: true, summary: "The letter hasn't been sent yet. It's waiting for your approval.", data: { status: c.status } };
      const last = c.updates[c.updates.length - 1];
      return {
        ok: true,
        summary: c.resolution ? c.resolution.detail : `${last.label}${last.providerRef ? ` (ref ${last.providerRef})` : ""}.`,
        data: { caseId: c.caseId, status: c.status, updates: c.updates, resolution: c.resolution },
      };
    },
  },
];
