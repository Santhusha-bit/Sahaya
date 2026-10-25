import { z } from "zod";
import type { AgentTool } from "../base/types";
import { createWorkItemStore } from "@/integrations/jira";
import { createFinanceAssistanceBridge, requestFinancialAssistance } from "@/integrations/fetchai";
import { getDataLayer } from "../base/dataLayer";
import { getCurrentUser } from "@/lib/user";
import { auth0Status, jiraStatus } from "@/lib/env";
import { startInvestigation } from "./investigation/service";
import { dispatchInvestigation } from "./investigation/worker";

export const financeTools: AgentTool[] = [
  {
    name: "analyzeMedicalBill",
    description: "Break down a medical bill into line items, compute the total, and flag unusual or duplicate charges.",
    inputSchema: z.object({
      provider: z.string().min(1),
      lineItems: z.array(z.object({ description: z.string(), amount: z.number() })).min(1),
    }),
    async execute(input, ctx) {
      const total = Number(input.lineItems.reduce((s: number, l: { amount: number }) => s + l.amount, 0).toFixed(2));
      const seen = new Map<string, number>();
      const flags: string[] = [];
      for (const li of input.lineItems) {
        seen.set(li.description, (seen.get(li.description) ?? 0) + 1);
        if (li.amount > 1000) flags.push(`High charge: ${li.description} ($${li.amount.toFixed(2)})`);
      }
      for (const [desc, count] of seen) if (count > 1) flags.push(`Possible duplicate: ${desc} x${count}`);
      const rec = await ctx.memory.save(
        "bills",
        { provider: input.provider, total, lineItems: input.lineItems, flags, status: "analyzed" },
        { tags: ["bill"] },
      );
      return {
        ok: true,
        summary: `Bill from ${input.provider}: $${total.toFixed(2)} across ${input.lineItems.length} item(s). ${flags.length ? `${flags.length} flag(s).` : "Nothing unusual."}`,
        data: { billId: rec.id, total, flags },
      };
    },
  },
  {
    name: "investigateBill",
    description:
      "Start a deeper investigation of a medical bill the person has authorized for review (itemized statement + insurance EOB). Runs in the background as a separate Factory Droid agent with read-only calculation tools; Finance verifies its findings. Never submits anything.",
    inputSchema: z.object({ documentIds: z.array(z.string()).optional().describe("Authorized document ids; omit to use all authorized bill documents.") }),
    async execute(input, ctx) {
      const inv = await startInvestigation({ memory: ctx.memory, tasks: ctx.tasks }, { documentIds: input.documentIds, correlationId: ctx.correlationId });
      await dispatchInvestigation(ctx.userId, inv.id);
      return {
        ok: true,
        summary:
          inv.engine === "factory-droid"
            ? `I've started a detailed investigation of this bill with a Factory Droid agent. You can follow its progress on the investigation screen.`
            : `I've started a detailed investigation of this bill (local engine; Factory Droid isn't configured). You can follow it on the investigation screen.`,
        data: { investigationId: inv.id, taskId: inv.taskId, engine: inv.engine },
      };
    },
  },
  {
    name: "compareInsuranceDocuments",
    description: "Compare what a bill charged against what insurance says is covered, and explain the gap.",
    inputSchema: z.object({
      billed: z.number(),
      covered: z.number(),
      service: z.string().min(1),
    }),
    async execute(input, ctx) {
      const responsibility = Number((input.billed - input.covered).toFixed(2));
      const rec = await ctx.memory.save("insuranceReviews", { ...input, responsibility });
      const note =
        responsibility <= 0
          ? "Insurance appears to cover this fully."
          : `You may owe about $${responsibility.toFixed(2)} after coverage.`;
      return { ok: true, summary: `For ${input.service}: billed $${input.billed.toFixed(2)}, covered $${input.covered.toFixed(2)}. ${note}`, data: { reviewId: rec.id, responsibility } };
    },
  },
  {
    name: "auditCareFacilityInvoice",
    description: "Audit a care-facility invoice for charges that don't match the agreed monthly rate or included services.",
    inputSchema: z.object({
      facility: z.string().min(1),
      agreedMonthly: z.number(),
      invoiceTotal: z.number(),
      extras: z.array(z.object({ description: z.string(), amount: z.number() })).default([]),
    }),
    async execute(input, ctx) {
      const extrasTotal = Number(input.extras.reduce((s: number, e: { amount: number }) => s + e.amount, 0).toFixed(2));
      const variance = Number((input.invoiceTotal - input.agreedMonthly - extrasTotal).toFixed(2));
      const flags: string[] = [];
      if (Math.abs(variance) > 0.01) flags.push(`Unexplained variance of $${variance.toFixed(2)}`);
      const rec = await ctx.memory.save("facilityAudits", { ...input, extrasTotal, variance, flags }, { tags: ["audit"] });
      return {
        ok: true,
        summary: `${input.facility}: invoice $${input.invoiceTotal.toFixed(2)} vs agreed $${input.agreedMonthly.toFixed(2)} + $${extrasTotal.toFixed(2)} extras. ${flags.length ? flags.join("; ") : "Matches expectations."}`,
        data: { auditId: rec.id, variance, flags },
      };
    },
  },
  {
    name: "detectRecurringCharges",
    description: "Scan transactions for recurring charges / subscriptions the person may have forgotten.",
    inputSchema: z.object({
      transactions: z
        .array(z.object({ merchant: z.string(), amount: z.number(), date: z.string() }))
        .optional()
        .describe("If omitted, uses stored transactions."),
    }),
    async execute(input, ctx) {
      let txns = input.transactions;
      if (!txns) {
        const stored = await ctx.memory.list("transactions");
        txns = stored.map((t) => ({ merchant: String(t.data.merchant), amount: Number(t.data.amount), date: String(t.data.date) }));
      }
      const byMerchant = new Map<string, number>();
      for (const t of txns) byMerchant.set(t.merchant, (byMerchant.get(t.merchant) ?? 0) + 1);
      const recurring = [...byMerchant.entries()].filter(([, c]) => c >= 2).map(([merchant, count]) => ({ merchant, count }));
      return {
        ok: true,
        summary: recurring.length ? `Found ${recurring.length} recurring merchant(s).` : "No recurring charges detected.",
        data: { recurring },
      };
    },
  },
  {
    name: "analyzeAuthorizedTransactions",
    description: "Summarize recent authorized transactions and compare spending to the person's norms.",
    inputSchema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    async execute(input, ctx) {
      const since = Date.now() - input.days * 86400_000;
      const txns = (await ctx.memory.list("transactions")).filter((t) => t.createdAt >= since);
      const total = Number(txns.reduce((s, t) => s + Number(t.data.amount ?? 0), 0).toFixed(2));
      return {
        ok: true,
        summary: `${txns.length} authorized transaction(s) in ${input.days} days, totaling $${total.toFixed(2)}.`,
        data: { count: txns.length, total },
      };
    },
  },
  {
    name: "prepareDispute",
    description: "Draft a dispute letter for an incorrect or suspicious charge (does not send it).",
    inputSchema: z.object({ billId: z.string().optional(), reason: z.string().min(1), amount: z.number().optional() }),
    async execute(input, ctx) {
      const rec = await ctx.memory.save(
        "disputes",
        { billId: input.billId, reason: input.reason, amount: input.amount, status: "drafted" },
        { tags: ["dispute"] },
      );
      return {
        ok: true,
        summary: `Drafted a dispute${input.amount ? ` for $${input.amount.toFixed(2)}` : ""}. I can submit it once you approve.`,
        data: { disputeId: rec.id },
      };
    },
  },
  {
    name: "requestFinancialApproval",
    description:
      "Request the person's approval to commit money or submit something official (e.g. file a dispute, pay a bill). The approved action is also logged as a reviewable controlled action (Atlassian Jira when configured, otherwise the local review store).",
    inputSchema: z.object({ action: z.string().min(1), amount: z.number().optional(), reference: z.string().optional() }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: input.amount ? `Approve: ${input.action} ($${input.amount.toFixed(2)})` : `Approve: ${input.action}`,
      description: `Finance wants to: ${input.action}${input.reference ? ` (ref ${input.reference})` : ""}.`,
    }),
    async execute(input, ctx) {
      // The person approved via the local approval gate (requiresApproval above).
      // Record the controlled action in the work-item review store so it is
      // auditable: live Jira mirrors each item to an issue; sandbox uses the
      // local reviewable store with the same interface. Reviewer identity comes
      // from Auth0 when configured (honest sandbox demo user otherwise).
      const user = getCurrentUser();
      const { service: workItems, backend } = createWorkItemStore();
      let workItemId: string | undefined;
      try {
        const wi = await workItems.propose({
          userId: ctx.userId,
          requestedAction: input.amount ? `${input.action} ($${input.amount.toFixed(2)})` : input.action,
          toolName: "requestFinancialApproval",
          requestingAgent: "finance",
          assignedAgent: "finance",
          permissionScope: "finance:commit-money",
          requiredRole: "caregiver",
          input,
        });
        workItemId = wi.id;
      } catch {
        // A review-store failure never blocks the already-approved action.
      }

      const rec = await ctx.memory.save(
        "financialActions",
        { ...input, status: "executed", workItemId, reviewBackend: backend, approvedBy: user.id, authMode: user.authMode },
        { tags: ["financial-action"] },
      );
      await ctx.tasks.create({
        title: input.action,
        steps: ["Approved", "Submitted", "Confirmed"],
        status: "in_progress",
        correlationId: ctx.correlationId,
      });
      const reviewNote = backend === "jira" ? " (mirrored to Jira for review)" : " (logged for review)";
      return {
        ok: true,
        summary: `Done: ${input.action}.${workItemId ? reviewNote : ""}`,
        data: { actionId: rec.id, workItemId, reviewBackend: backend },
      };
    },
  },
  {
    name: "requestAssistanceCoordination",
    description:
      "When the person needs a human to help with a financial task they cannot complete alone (e.g. sitting with them to dispute a large overcharge, or completing a benefits enrollment), ask Guardian to coordinate a helper. Carried over the Fetch.ai assistance bridge; records the person's consent first and sends only the minimum needed (need, urgency, consent reference), never the financial detail.",
    inputSchema: z.object({
      need: z.string().min(1).max(300),
      urgency: z.enum(["routine", "soon", "urgent"]).default("soon"),
    }),
    async execute(input, ctx) {
      const consent = await ctx.memory.save(
        "consents",
        { purpose: "financial_assistance", need: input.need, grantedAt: Date.now() },
        { tags: ["consent"] },
      );
      const bridge = createFinanceAssistanceBridge({ data: getDataLayer(), consent: undefined });
      const { response, userMessage } = await requestFinancialAssistance(bridge, {
        userId: ctx.userId,
        need: input.need,
        consentRef: consent.id,
        urgency: input.urgency,
      });
      const ok = response.status === "accepted";
      return {
        ok,
        summary: userMessage,
        data: { backend: bridge.backend, taskId: response.task_id, status: response.status, consentRef: consent.id },
        error: ok ? undefined : response.reason,
      };
    },
  },
  {
    name: "checkAuthStatus",
    description:
      "Report who Finance is acting for and how they are authenticated (Auth0 when configured, otherwise the single demo user). Use when the person asks who you are acting on behalf of, or to confirm sign-in.",
    inputSchema: z.object({}),
    async execute() {
      const user = getCurrentUser();
      const auth = auth0Status();
      const jira = jiraStatus();
      return {
        ok: true,
        summary:
          user.authMode === "live"
            ? `Acting for ${user.name} (${user.role}), signed in via Auth0.`
            : `Acting for ${user.name} (${user.role}) in single-user demo mode (Auth0 not configured).`,
        data: {
          userId: user.id,
          role: user.role,
          authMode: user.authMode,
          auth0: auth.mode,
          controlledActionReview: jira.mode === "live" ? "jira" : "local",
        },
      };
    },
  },
  {
    name: "searchBenefits",
    description: "Find assistance programs / benefits the person may qualify for.",
    inputSchema: z.object({ topic: z.string().min(1).describe("e.g. 'prescription costs', 'home care', 'utilities'") }),
    async execute(input) {
      const PROGRAMS: Record<string, string[]> = {
        prescription: ["Medicare Extra Help (Part D)", "Patient assistance programs via manufacturers"],
        home: ["Medicaid Home & Community-Based Services waiver", "Area Agency on Aging in-home support"],
        utilities: ["LIHEAP (energy assistance)", "Lifeline phone/internet discount"],
      };
      const key = Object.keys(PROGRAMS).find((k) => input.topic.toLowerCase().includes(k));
      const programs = key ? PROGRAMS[key] : ["Contact your local Area Agency on Aging for a benefits screening."];
      return { ok: true, summary: `${programs.length} program(s) to look into.`, data: { programs } };
    },
  },
  {
    name: "generateCareCostProjection",
    description: "Project future care costs based on a monthly figure and horizon.",
    inputSchema: z.object({ monthlyCost: z.number().positive(), months: z.number().int().min(1).max(120).default(12), inflation: z.number().min(0).max(0.2).default(0.03) }),
    async execute(input, ctx) {
      let total = 0;
      let monthly = input.monthlyCost;
      for (let i = 0; i < input.months; i++) {
        total += monthly;
        if ((i + 1) % 12 === 0) monthly *= 1 + input.inflation;
      }
      total = Number(total.toFixed(2));
      const rec = await ctx.memory.save("projections", { ...input, total });
      return {
        ok: true,
        summary: `Projected ~$${total.toLocaleString()} over ${input.months} month(s) (at ${(input.inflation * 100).toFixed(0)}%/yr).`,
        data: { projectionId: rec.id, total },
      };
    },
  },
];
