import { z } from "zod";
import type { AgentTool } from "../base/types";
import type { ToolContext } from "../base/types";
import { getHouseholdCoordinator } from "@/integrations/jira";
import { createWorkItemStore } from "@/integrations/jira";
import { createFinanceAssistanceBridge, requestFinancialAssistance } from "@/integrations/fetchai";
import { getDataLayer } from "../base/dataLayer";
import { getCurrentUser } from "@/lib/user";
import { auth0Status, jiraStatus } from "@/lib/env";
import { getNessieClient } from "@/integrations/nessie";
import {
  BankNotAuthorizedError,
  connectBank,
  currentSuggestions,
  decideSuggestion,
  fetchAuthorizedTransactions,
  revokeBank,
  runSpendingAnalysis,
} from "./nessie/service";

const notConnected = (err: unknown) =>
  err instanceof BankNotAuthorizedError
    ? { ok: false, summary: err.message, error: "bank_not_authorized" }
    : null;

/** Capital One Nessie: authorized bank data -> spending review. */
const bankTools: AgentTool[] = [
  {
    name: "connectSandboxBankAccount",
    description:
      "Ask the person to let Finance read purchases from their Capital One (Nessie sandbox) checking account. Needs their approval. Read-only: Finance can never move money or create purchases.",
    inputSchema: z.object({}),
    requiresApproval: true,
    approvalSummary: () => ({
      title: "Let Finance read your checking account",
      description:
        "Finance will read purchases from your Capital One sandbox checking account to review spending. Read-only: it cannot move money. You can disconnect any time.",
    }),
    async execute(_input, ctx) {
      const { connection, created } = await connectBank({ memory: ctx.memory, nessie: getNessieClient() });
      return {
        ok: true,
        summary: `Connected ${connection.nickname} ending ${connection.last4} (${connection.backend === "live" ? "Capital One Nessie" : "Nessie sandbox emulator"}, read-only).${created ? ` ${connection.purchasesSeeded} test purchases loaded.` : ""}`,
        data: { last4: connection.last4, backend: connection.backend, created },
      };
    },
  },
  {
    name: "fetchBankTransactions",
    description: "List purchases from the person's connected (authorized) bank account. Only works after they approved access.",
    inputSchema: z.object({ days: z.number().int().min(1).max(120).default(30) }),
    async execute(input, ctx) {
      try {
        const { connection, transactions } = await fetchAuthorizedTransactions({ memory: ctx.memory, nessie: getNessieClient() }, { days: input.days });
        const total = transactions.reduce((s, t) => s + (t.status === "cancelled" ? 0 : t.amount), 0);
        return {
          ok: true,
          summary: `${transactions.length} purchase(s) in the last ${input.days} days on ${connection.nickname} ending ${connection.last4}, totaling $${total.toFixed(2)}.`,
          data: { transactions: transactions.map(({ date, merchant, amount, status }) => ({ date, merchant, amount, status })) },
        };
      } catch (err) {
        const blocked = notConnected(err);
        if (blocked) return blocked;
        throw err;
      }
    },
  },
  {
    name: "runSpendingAnalysis",
    description:
      "Review the connected bank account: categorize every purchase, find possible double charges and subscriptions (including price increases), build this month's spending summary, flag purchases that are new since the last review, and save suggested actions for the person to accept or dismiss.",
    inputSchema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("YYYY-MM; defaults to this month") }),
    async execute(input, ctx) {
      try {
        const { analysis, analysisId } = await runSpendingAnalysis(
          { memory: ctx.memory, nessie: getNessieClient(), tasks: ctx.tasks },
          { month: input.month },
        );
        const suggestions = await currentSuggestions(ctx.memory);
        return {
          ok: true,
          summary: analysis.spoken,
          data: {
            analysisId,
            month: analysis.month,
            total: analysis.summary.total,
            previousTotal: analysis.summary.previousTotal,
            topCategories: analysis.summary.byCategory.slice(0, 4).map((c) => ({ category: c.label, total: c.total })),
            subscriptions: analysis.subscriptions.map((s) => ({ merchant: s.merchant, monthly: s.monthlyAmount, priceIncrease: s.priceIncrease })),
            duplicates: analysis.duplicates.map((d) => ({ merchant: d.merchant, amount: d.amount, dates: d.dates })),
            newTransactions: analysis.newTransactions,
            categorizedBy: analysis.reviewer,
            pendingSuggestions: suggestions.filter((s) => s.status === "suggested").map((s) => ({ actionId: s.id, title: s.title })),
          },
        };
      } catch (err) {
        const blocked = notConnected(err);
        if (blocked) return blocked;
        throw err;
      }
    },
  },
  {
    name: "reviewSuggestedAction",
    description:
      "Record the person's decision on one suggestion from the spending review. Only call this when the person has clearly said accept or dismiss for that specific suggestion. Accepting a double-charge suggestion only drafts a dispute (sending it needs requestFinancialApproval); accepting a subscription suggestion adds a to-do, Finance never cancels anything itself.",
    inputSchema: z.object({ actionId: z.string().min(1), decision: z.enum(["accept", "dismiss"]) }),
    async execute(input, ctx) {
      const { outcome, disputeId } = await decideSuggestion({ memory: ctx.memory, tasks: ctx.tasks }, input.actionId, input.decision);
      return { ok: true, summary: outcome, data: { disputeId } };
    },
  },
  {
    name: "disconnectBankAccount",
    description: "Revoke Finance's read access to the connected bank account.",
    inputSchema: z.object({}),
    async execute(_input, ctx) {
      const revoked = await revokeBank(ctx.memory);
      return {
        ok: true,
        summary: revoked ? "Disconnected. Finance can no longer read that account." : "No bank account was connected.",
        data: { revoked },
      };
    },
  },
];
import { CREDIT_REVIEW_PURPOSES } from "./credit/creditPolicy";
import { REVIEW_COLLECTION, runCreditReview } from "./credit/creditReview";
import { linkedPersonaId } from "./credit/testIdentities";
import { investigationTools } from "./investigationTools";

export const financeTools: AgentTool[] = [
  ...bankTools,
  ...investigationTools,
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
    name: "reviewCreditAndIdentity",
    description:
      "Run a credit and identity review through the CRS Credit API sandbox for the CRS test identity linked to this account: TransUnion credit report (score, accounts, inquiries), TransUnion identity verification, and AtData FraudFinder contact-risk signals. Explains what changed or looks wrong and recommends next steps. Requires the person's approval for each pull. Does NOT cover bank transactions.",
    inputSchema: z.object({
      purpose: z.enum(CREDIT_REVIEW_PURPOSES).default("identity_protection_review"),
      products: z
        .array(z.enum(["credit_report", "identity_verification", "fraud_finder"]))
        .min(1)
        .default(["credit_report", "identity_verification", "fraud_finder"]),
      personaId: z.string().regex(/^P\d{2}$/).optional().describe("Omit: defaults to the identity linked to this account."),
    }),
    requiresApproval: true,
    approvalSummary: (input) => ({
      title: "Approve: credit & identity review",
      description: `Finance wants to request your credit report and identity checks from CRS (soft inquiry, sandbox test identity ${input.personaId ?? linkedPersonaId()}) for: ${String(input.purpose).replace(/_/g, " ")}. Nothing on any account will change.`,
    }),
    async execute(input, ctx) {
      return runCreditReview(ctx, input);
    },
  },
  {
    name: "listCreditReviews",
    description: "Show past credit and identity reviews with their CRS request ids, findings, and audit trail.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    async execute(input, ctx) {
      const reviews = (await ctx.memory.list(REVIEW_COLLECTION, { limit: 200 }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, input.limit);
      const auditTrail = (await ctx.audit.list({ limit: 500 })).filter(
        (e) => e.actor === "finance" && (e.action.startsWith("credit.") || e.action.startsWith("crs.")),
      );
      return {
        ok: true,
        summary: reviews.length
          ? `${reviews.length} credit review(s). Latest: ${String(reviews[0].data.overall)} on ${new Date(reviews[0].createdAt).toLocaleDateString()} (${String(reviews[0].data.mode)}).`
          : "No credit reviews yet.",
        data: {
          reviews: reviews.map((r) => ({
            reviewId: r.id,
            at: r.createdAt,
            mode: r.data.mode,
            overall: r.data.overall,
            requestIds: (r.data.requests as Array<{ requestId?: string }> | undefined)?.map((q) => q.requestId),
            findings: (r.data.findings as Array<{ id: string; severity: string }> | undefined)?.map((f) => `${f.severity}:${f.id}`),
          })),
          auditTrail,
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
  {
    name: "executeDelegatedWorkItem",
    description:
      "Carry out a work item another agent assigned to Finance (e.g. a payment Guardian flagged), but only if the execution gate confirms it was approved by the required family reviewers for exactly these parameters. Refusals are explained, never retried around.",
    inputSchema: z.object({ workItemId: z.string().min(1) }),
    async execute(input, ctx) {
      const { service } = getHouseholdCoordinator(ctx.userId);
      const item = await service.get(input.workItemId);
      if (!item || item.userId !== ctx.userId) return { ok: false, summary: "I couldn't find that work item.", error: "not_found" };
      const run = DELEGATED_EXECUTORS[item.toolName];
      if (!run) return { ok: false, summary: `I don't know how to run "${item.toolName}".`, error: "no_executor" };
      // Execute what the item holds; the gate re-hashes it, so a store-level edit
      // of the parameters after approval is caught as input_tampered.
      const res = await service.execute(item.id, { agentId: ctx.agentId, toolName: item.toolName, input: item.input }, (wi) => run(wi.input as Record<string, unknown>, ctx));
      await ctx.audit.record({
        actor: ctx.agentId,
        action: res.ok ? "work_item.executed" : "work_item.execution_denied",
        correlationId: ctx.correlationId,
        detail: { workItemId: item.id, gate: res.gate.code ?? "ok" },
      });
      return res.ok
        ? { ok: true, summary: res.result ?? "Done.", data: { workItemId: item.id, status: "executed" } }
        : { ok: false, summary: `Not executed: ${res.gate.reason}`, error: res.gate.code, data: { workItemId: item.id } };
    },
  },
];

/** Side effects for approved, delegated finance work items (sandbox: recorded in Finance memory). */
const DELEGATED_EXECUTORS: Record<string, (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>> = {
  async executePayment(input, ctx) {
    const rec = await ctx.memory.save("payments", { ...input, status: "sent", mode: "sandbox" }, { tags: ["financial-action"] });
    return `Paid $${Number(input.amount).toFixed(2)} to ${String(input.payee ?? "payee")} (payment ${rec.id}).`;
  },
  async freezeCard(input, ctx) {
    const rec = await ctx.memory.save("cardActions", { ...input, status: "frozen", mode: "sandbox" }, { tags: ["financial-action"] });
    return `Card ending ${String(input.last4 ?? "????")} frozen (${rec.id}).`;
  },
  async fileBillingDispute(input, ctx) {
    const rec = await ctx.memory.save("disputes", { ...input, status: "filed", mode: "sandbox" }, { tags: ["financial-action"] });
    return `Dispute filed with ${String(input.merchant ?? "merchant")} (${rec.id}).`;
  },
};
