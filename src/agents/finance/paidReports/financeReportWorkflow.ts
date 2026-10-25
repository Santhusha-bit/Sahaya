/**
 * Finance's x402 buyer workflow for specialized financial-data reports.
 * OPTIONAL EXPERIMENT, off unless FINANCE_X402_REPORTS is enabled.
 *
 *  1. Finance requests the report; the service answers 402 with the price.
 *  2. financeReportPolicy (pure code) checks it. Finance holds no standing
 *     mandate, so a legitimate quote ALWAYS becomes an approval card bound to
 *     that exact requirement (hash, single use, 10 minute expiry).
 *  3. Only after the person approves: Finance re-requests, the policy re-checks
 *     the live quote against the approved hash, caps and daily budget, and the
 *     sandbox wallet signs an EIP-3009 authorization. The service's local
 *     verifier checks it; nothing settles and no funds move.
 *  4. Finance stores the report, records the cost in its ledger + audit log, and
 *     applies the report to whatever the person asked about.
 *
 * Finance never touches the funded X402_WALLET_PRIVATE_KEY or X402_SERVICE_URL:
 * it pays from its own throwaway key, to the in-process service only.
 */

import { generatePrivateKey } from "viem/accounts";
import { now } from "@/lib/id";
import {
  createWallet,
  decodeHeader,
  encodeHeader,
  formatUsd,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  parsePaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
  type X402Wallet,
} from "@/integrations/x402";
import { IN_PROCESS_ORIGIN } from "@/agents/care/paidServices/registry";
import type { MemoryRecord, ScopedMemory, ToolContext, ToolResult } from "../../base/types";
import { handleFinancialReport, REPORT_TITLES, type FinancialReport, type Region, type ReportId } from "./financialReportService";
import { evaluateFinanceReportPayment } from "./financeReportPolicy";
import { describeInsights, incorporateReport, type ReportContext } from "./reportInsights";
import { financialReportService, findFinanceReportService } from "./registry";

export const REPORT_QUOTES = "x402ReportQuotes";
export const REPORT_LEDGER = "x402ReportLedger";
export const REPORTS = "financialReports";

export const QUOTE_TTL_MS = 10 * 60 * 1000;
/** A report bought in the last day is reused instead of bought again. */
export const REPORT_REUSE_MS = 24 * 60 * 60 * 1000;

export function financeReportsEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test(process.env.FINANCE_X402_REPORTS?.trim() ?? "");
}

// ---------------------------------------------------------------------------
// Finance's sandbox wallet + in-process transport (test hooks via globalThis)
// ---------------------------------------------------------------------------

const WALLET_KEY = "__sahaya_x402_finance_wallet__";
const TRANSPORT_KEY = "__sahaya_x402_finance_transport__";

/** Always a throwaway key with no funds. Never reads X402_WALLET_PRIVATE_KEY. */
export function getFinanceWallet(): X402Wallet {
  const g = globalThis as Record<string, unknown>;
  if (!g[WALLET_KEY]) g[WALLET_KEY] = createWallet(generatePrivateKey(), "ephemeral");
  return g[WALLET_KEY] as X402Wallet;
}

export function setFinanceWallet(w: X402Wallet | null): void {
  const g = globalThis as Record<string, unknown>;
  if (w) g[WALLET_KEY] = w;
  else delete g[WALLET_KEY];
}

export type ReportTransport = (url: string, headers: Record<string, string>) => Promise<Response>;

function getTransport(): ReportTransport {
  const override = (globalThis as Record<string, unknown>)[TRANSPORT_KEY] as ReportTransport | undefined;
  return override ?? ((url, headers) => handleFinancialReport(new Request(url, { headers })));
}

export function setReportTransport(t: ReportTransport | null): void {
  const g = globalThis as Record<string, unknown>;
  if (t) g[TRANSPORT_KEY] = t;
  else delete g[TRANSPORT_KEY];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function reportLedger(memory: ScopedMemory): Promise<MemoryRecord[]> {
  return (await memory.list(REPORT_LEDGER)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function reportSpentTodayAtomic(memory: ScopedMemory, at = now()): Promise<bigint> {
  const from = startOfDay(at);
  return (await reportLedger(memory))
    .filter((r) => Number(r.data.at ?? r.createdAt) >= from)
    .reduce((sum, r) => sum + BigInt(String(r.data.amountAtomic ?? "0")), 0n);
}

/** Most recent purchased report of a kind, for other Finance tools to consult. */
export async function latestReport(memory: ScopedMemory, reportId: ReportId): Promise<FinancialReport | null> {
  const rows = (await memory.list(REPORTS)).filter((r) => r.data.reportId === reportId).sort((a, b) => b.createdAt - a.createdAt);
  return rows[0] ? (rows[0].data.report as FinancialReport) : null;
}

// ---------------------------------------------------------------------------
// Request (quote only) and approved purchase
// ---------------------------------------------------------------------------

export interface ReportRequest {
  report: ReportId;
  region: Region;
  context?: ReportContext;
}

export interface ApprovedReportQuote {
  quoteId: string;
  requirementHash: string;
}

const DISABLED: ToolResult = {
  ok: false,
  summary: "Paid financial reports are an optional experiment that is turned off (set FINANCE_X402_REPORTS=on to try it).",
  error: "experiment_disabled",
};

function reportUrl(request: ReportRequest): URL {
  const url = new URL(financialReportService().resourcePath, IN_PROCESS_ORIGIN);
  url.searchParams.set("report", request.report);
  url.searchParams.set("region", request.region);
  return url;
}

async function fetchQuote(
  ctx: ToolContext,
  url: URL,
): Promise<{ ok: true; requirement: PaymentRequirements } | { ok: false; result: ToolResult }> {
  let first: Response;
  try {
    first = await getTransport()(url.toString(), {});
  } catch (err) {
    return { ok: false, result: { ok: false, summary: "The financial-report service is unreachable right now.", error: err instanceof Error ? err.message : String(err) } };
  }
  if (first.status === 404) return { ok: false, result: { ok: false, summary: "That report isn't offered.", error: "not_offered" } };
  if (first.status !== 402) {
    return { ok: false, result: { ok: false, summary: `Unexpected response from the report service (${first.status}).`, error: `http_${first.status}` } };
  }
  const body = parsePaymentRequired(await first.json().catch(() => null));
  const requirement = body?.accepts.find((r) => r.scheme === "exact" && r.network === financialReportService().network) ?? body?.accepts[0];
  if (!requirement) {
    await ctx.audit.record({ actor: "finance", action: "x402.refused", correlationId: ctx.correlationId, detail: { reason: "no usable payment requirement" } });
    return { ok: false, result: { ok: false, summary: "The service asked for payment in a form I can't safely use.", error: "x402_no_requirement" } };
  }
  return { ok: true, requirement };
}

/**
 * Step 1: get the quoted price and ask the person. Never pays, whatever the price.
 * Reuses a report bought in the last day instead of paying twice.
 */
export async function requestFinancialReport(ctx: ToolContext, request: ReportRequest): Promise<ToolResult> {
  if (!financeReportsEnabled()) return DISABLED;
  const title = REPORT_TITLES[request.report];

  const cached = (await ctx.memory.list(REPORTS))
    .filter((r) => r.data.reportId === request.report && r.data.region === request.region && now() - r.createdAt < REPORT_REUSE_MS)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (cached) {
    const insights = incorporateReport(cached.data.report as FinancialReport, request.context);
    return {
      ok: true,
      summary: `I already bought the ${title} (${request.region}) today, so no new payment. ${describeInsights(insights)}`,
      data: { status: "reused", reportRecordId: cached.id, report: cached.data.report, insights },
    };
  }

  const quote = await fetchQuote(ctx, reportUrl(request));
  if (!quote.ok) return quote.result;
  const { requirement } = quote;

  const wallet = getFinanceWallet();
  const decision = evaluateFinanceReportPayment({
    requirement,
    service: findFinanceReportService(requirement.resource),
    spentTodayAtomic: await reportSpentTodayAtomic(ctx.memory),
    walletBackend: wallet.backend,
    now: now(),
  });
  await ctx.audit.record({
    actor: "finance",
    action: `x402.${decision.action}`,
    correlationId: ctx.correlationId,
    detail: { resource: requirement.resource, amountAtomic: requirement.maxAmountRequired, payTo: requirement.payTo, reasons: decision.reasons, requirementHash: decision.requirementHash },
  });
  const price = formatUsd(decision.amountUsd);

  if (decision.action !== "needs_approval") {
    // "pay" is impossible here (no approval yet); treat anything else as a refusal.
    return { ok: false, summary: `I won't buy that report: ${decision.reasons.join("; ")}.`, error: "x402_refused", data: { decision } };
  }

  const quoteRec = await ctx.memory.save(
    REPORT_QUOTES,
    {
      report: request.report,
      region: request.region,
      context: (request.context ?? null) as unknown as Record<string, unknown> | null,
      requirement,
      requirementHash: decision.requirementHash,
      amountUsd: decision.amountUsd,
      status: "pending",
      expiresAt: now() + QUOTE_TTL_MS,
    },
    { tags: ["x402", "quote", "financial-report"] },
  );
  const approval = await ctx.approvals.request({
    toolName: "purchaseApprovedFinancialReport",
    toolInput: { quoteId: quoteRec.id, requirementHash: decision.requirementHash },
    title: `Pay ${price} for a financial report`,
    description: `Finance wants to buy the "${title}" (${request.region}) report for ${price}. Sandbox test payment: no real money moves. Finance has no spending authority of its own, so it needs your OK for this exact price; the quote expires in 10 minutes.`,
    correlationId: ctx.correlationId,
  });
  return {
    ok: true,
    summary: `The ${title} report costs ${price}. I've asked for your approval before buying it.`,
    approvalId: approval.id,
    data: { status: "awaiting_approval", quoteId: quoteRec.id, amountUsd: decision.amountUsd, requirementHash: decision.requirementHash },
  };
}

/** Step 2: run an approved quote exactly once, then incorporate the report. */
export async function purchaseApprovedReport(ctx: ToolContext, input: ApprovedReportQuote): Promise<ToolResult> {
  if (!financeReportsEnabled()) return DISABLED;
  const quote = await ctx.memory.get(input.quoteId);
  if (!quote || quote.collection !== REPORT_QUOTES) return { ok: false, summary: "That report quote no longer exists.", error: "quote_not_found" };
  if (quote.data.status !== "pending") return { ok: false, summary: "That report was already handled; I won't pay twice.", error: "quote_already_used" };
  if (Number(quote.data.expiresAt) <= now()) {
    await ctx.memory.update(quote.id, { status: "expired" });
    return { ok: false, summary: "That approval expired. Ask me again for a fresh quote.", error: "quote_expired" };
  }
  if (quote.data.requirementHash !== input.requirementHash) {
    return { ok: false, summary: "The approved payment doesn't match the quote, so I didn't pay.", error: "quote_mismatch" };
  }
  // Consume before paying so a duplicate approval can never pay twice.
  await ctx.memory.update(quote.id, { status: "used", usedAt: now() });
  const fail = async (result: ToolResult): Promise<ToolResult> => {
    await ctx.memory.update(quote.id, { status: "failed", error: result.error ?? null });
    return result;
  };

  const request: ReportRequest = {
    report: quote.data.report as ReportId,
    region: quote.data.region as Region,
    context: (quote.data.context ?? undefined) as ReportContext | undefined,
  };
  const url = reportUrl(request);
  const fresh = await fetchQuote(ctx, url);
  if (!fresh.ok) return fail(fresh.result);
  const { requirement } = fresh;

  const wallet = getFinanceWallet();
  const decision = evaluateFinanceReportPayment({
    requirement,
    service: findFinanceReportService(requirement.resource),
    spentTodayAtomic: await reportSpentTodayAtomic(ctx.memory),
    walletBackend: wallet.backend,
    approvedHash: input.requirementHash,
    now: now(),
  });
  await ctx.audit.record({
    actor: "finance",
    action: `x402.${decision.action}`,
    correlationId: ctx.correlationId,
    detail: { resource: requirement.resource, amountAtomic: requirement.maxAmountRequired, reasons: decision.reasons, requirementHash: decision.requirementHash, quoteId: quote.id },
  });
  if (decision.action !== "pay" || decision.authorizedBy !== "approval") {
    return fail({ ok: false, summary: `I didn't pay: ${decision.reasons.join("; ")}.`, error: "x402_refused", data: { decision } });
  }

  let paid: Response;
  try {
    const payment = await wallet.signExact(requirement);
    paid = await getTransport()(url.toString(), { [PAYMENT_HEADER]: encodeHeader(payment) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.audit.record({ actor: "finance", action: "x402.payment_failed", correlationId: ctx.correlationId, detail: { error: message } });
    return fail({ ok: false, summary: "The payment couldn't be completed, so nothing was charged.", error: message });
  }
  const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  const settlement = receiptHeader ? (() => { try { return decodeHeader<SettleResponse>(receiptHeader); } catch { return null; } })() : null;
  const body = paid.status === 200 ? ((await paid.json().catch(() => null)) as { report?: FinancialReport; settlement?: string } | null) : null;
  if (!settlement?.success || !body?.report || body.settlement !== "sandbox") {
    const reason = paid.status !== 200 ? `http_${paid.status}` : body?.settlement !== "sandbox" ? "not_sandbox" : "rejected";
    await ctx.audit.record({ actor: "finance", action: "x402.payment_failed", correlationId: ctx.correlationId, detail: { status: paid.status, reason } });
    return fail({ ok: false, summary: "The report service didn't accept the sandbox payment, so nothing was recorded.", error: reason });
  }

  const report = body.report;
  const stored = await ctx.memory.save(
    REPORTS,
    { reportId: report.reportId, region: report.region, resource: requirement.resource, report: report as unknown as Record<string, unknown> },
    { tags: ["financial-report", report.reportId] },
  );
  const entry = await ctx.memory.save(
    REPORT_LEDGER,
    {
      service: financialReportService().id,
      report: report.reportId,
      region: report.region,
      resource: requirement.resource,
      amountAtomic: requirement.maxAmountRequired,
      amountUsd: decision.amountUsd,
      network: requirement.network,
      payTo: requirement.payTo,
      payer: settlement.payer ?? wallet.address,
      transaction: settlement.transaction,
      settlement: "sandbox",
      authorizedBy: "approval",
      quoteId: quote.id,
      reportRecordId: stored.id,
      at: now(),
    },
    { tags: ["x402", "purchase", "sandbox"] },
  );
  await ctx.audit.record({
    actor: "finance",
    action: "x402.paid",
    correlationId: ctx.correlationId,
    detail: { purchaseId: entry.id, amountAtomic: requirement.maxAmountRequired, transaction: settlement.transaction, settlement: "sandbox", authorizedBy: "approval" },
  });

  const insights = incorporateReport(report, request.context);
  const price = formatUsd(decision.amountUsd);
  await ctx.tasks.create({
    title: `Bought report: ${report.title} (${price}, sandbox)`,
    steps: ["Quoted (402)", "Approved by you", "Paid (sandbox)", "Report applied"],
    status: "completed",
    result: describeInsights(insights),
    correlationId: ctx.correlationId,
  });
  await ctx.memory.update(quote.id, { status: "completed", purchaseId: entry.id });

  return {
    ok: true,
    summary: `Paid ${price} (sandbox, no funds moved) for the ${report.title}. ${describeInsights(insights)} ${report.dataNotice}`,
    data: {
      report,
      insights,
      purchase: { id: entry.id, amountUsd: decision.amountUsd, authorizedBy: "approval", transaction: settlement.transaction, settlement: "sandbox", payer: settlement.payer ?? wallet.address },
    },
  };
}
