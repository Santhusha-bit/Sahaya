/**
 * Care's x402 buyer workflow (paid agent services).
 *
 *  1. Care requests the paid product-data resource.
 *  2. The service answers 402 with x402 PaymentRequirements.
 *  3. x402Policy (pure code) checks the amount against the standing mandate.
 *  4. Outside the mandate -> a quote is stored and the person is asked to approve
 *     exactly that requirement (bound by hash, single use, short expiry).
 *  5. Within the mandate (or approved) -> the wallet signs an EIP-3009
 *     authorization and Care retries with X-PAYMENT; the service settles.
 *  6. Care receives the data, records the cost in its ledger + the audit log, and
 *     sends Finance a receipt over the authorized bus.
 *
 * Every refusal and payment is audit-logged. A failed payment records no spend.
 */

import { now } from "@/lib/id";
import {
  decodeHeader,
  encodeHeader,
  formatUsd,
  getX402Wallet,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  parsePaymentRequired,
  TEST_NETWORK,
  type PaymentRequirements,
  type SettleResponse,
} from "@/integrations/x402";
import type { MemoryRecord, ScopedMemory, ToolContext, ToolResult } from "../../base/types";
import { handleProductCompare, type ComparisonTier } from "./productCompareService";
import { findServiceForResource, IN_PROCESS_ORIGIN, productCompareService } from "./registry";
import { evaluateX402Payment, type SpendingMandate } from "./x402Policy";

export const MANDATES = "x402Mandates";
export const LEDGER = "x402Ledger";
export const QUOTES = "x402Quotes";

/** How long a person has to approve an over-limit quote. */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

export const DEFAULT_MANDATE = { perPaymentLimitUsd: 0.05, dailyLimitUsd: 0.25 } as const;

// ---------------------------------------------------------------------------
// Transport: in-process service by default, real HTTP when X402_SERVICE_URL set
// ---------------------------------------------------------------------------

export type X402Transport = (url: string, headers: Record<string, string>) => Promise<Response>;

const TRANSPORT_KEY = "__sahaya_x402_transport__";

export function getTransport(): { transport: X402Transport; origin: string } {
  const override = (globalThis as Record<string, unknown>)[TRANSPORT_KEY] as { transport: X402Transport; origin: string } | undefined;
  if (override) return override;
  const external = process.env.X402_SERVICE_URL?.trim();
  if (external) {
    return { origin: new URL(external).origin, transport: (url, headers) => fetch(url, { headers }) };
  }
  return { origin: IN_PROCESS_ORIGIN, transport: (url, headers) => handleProductCompare(new Request(url, { headers })) };
}

export function setTransport(t: { transport: X402Transport; origin: string } | null): void {
  const g = globalThis as Record<string, unknown>;
  if (t) g[TRANSPORT_KEY] = t;
  else delete g[TRANSPORT_KEY];
}

// ---------------------------------------------------------------------------
// Mandate + ledger (Care-scoped memory)
// ---------------------------------------------------------------------------

export async function grantMandate(
  memory: ScopedMemory,
  limits: { perPaymentLimitUsd: number; dailyLimitUsd: number },
  grantedBy = "user",
): Promise<SpendingMandate> {
  for (const m of await memory.list(MANDATES)) {
    if (!m.data.revoked) await memory.update(m.id, { revoked: true });
  }
  const data: Omit<SpendingMandate, "id"> = {
    perPaymentLimitUsd: limits.perPaymentLimitUsd,
    dailyLimitUsd: limits.dailyLimitUsd,
    allowedServiceIds: [productCompareService().id],
    network: TEST_NETWORK,
    grantedBy,
    grantedAt: now(),
    revoked: false,
  };
  const rec = await memory.save(MANDATES, data as unknown as Record<string, unknown>, { tags: ["x402", "mandate"] });
  return { id: rec.id, ...data };
}

export async function activeMandate(memory: ScopedMemory): Promise<SpendingMandate | null> {
  const rows = await memory.list(MANDATES);
  const live = rows.filter((r) => !r.data.revoked).sort((a, b) => b.createdAt - a.createdAt)[0];
  return live ? ({ id: live.id, ...(live.data as Omit<SpendingMandate, "id">) } as SpendingMandate) : null;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function ledger(memory: ScopedMemory): Promise<MemoryRecord[]> {
  return (await memory.list(LEDGER)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function spentTodayAtomic(memory: ScopedMemory, at = now()): Promise<bigint> {
  const from = startOfDay(at);
  return (await ledger(memory))
    .filter((r) => Number(r.data.at ?? r.createdAt) >= from)
    .reduce((sum, r) => sum + BigInt(String(r.data.amountAtomic ?? "0")), 0n);
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export interface ApprovedQuote {
  quoteId: string;
  requirementHash: string;
}

function describeComparison(c: Record<string, any>): string {
  const parts = [`Best value: ${c.bestValue?.name} ($${Number(c.bestValue?.unitPricePerOz).toFixed(3)}/oz).`];
  if (c.lowestSodium) parts.push(`Lowest sodium: ${c.lowestSodium.name} (${c.lowestSodium.sodiumMg}mg).`);
  if (c.recommended) parts.push(`My pick for you: ${c.recommended.name}. ${c.recommended.why}`);
  return parts.join(" ");
}

export async function purchaseComparison(
  ctx: ToolContext,
  request: { query: string; tier: ComparisonTier },
  approved?: ApprovedQuote,
): Promise<ToolResult> {
  const service = productCompareService();
  const { transport, origin } = getTransport();
  const url = new URL(service.resourcePath, origin);
  url.searchParams.set("q", request.query);
  url.searchParams.set("tier", request.tier);

  // 1-2. Ask for the resource; expect 402 Payment Required.
  let first: Response;
  try {
    first = await transport(url.toString(), {});
  } catch (err) {
    return { ok: false, summary: "The product-data service is unreachable right now.", error: err instanceof Error ? err.message : String(err) };
  }
  if (first.status === 404) {
    return { ok: false, summary: `The comparison service doesn't cover "${request.query}" yet.`, error: "not_covered" };
  }
  if (first.status !== 402) {
    return { ok: false, summary: `Unexpected response from the product-data service (${first.status}).`, error: `http_${first.status}` };
  }
  const body = parsePaymentRequired(await first.json().catch(() => null));
  const requirement: PaymentRequirements | undefined =
    body?.accepts.find((r) => r.scheme === "exact" && r.network === service.network) ?? body?.accepts[0];
  if (!requirement) {
    await ctx.audit.record({ actor: "care", action: "x402.refused", correlationId: ctx.correlationId, detail: { reason: "no usable payment requirement" } });
    return { ok: false, summary: "The service asked for payment in a form I can't safely use.", error: "x402_no_requirement" };
  }

  // 3. Deterministic policy decision.
  const mandate = await activeMandate(ctx.memory);
  const spent = await spentTodayAtomic(ctx.memory);
  const decision = evaluateX402Payment({
    requirement,
    service: findServiceForResource(requirement.resource),
    mandate,
    spentTodayAtomic: spent,
    approvedHash: approved?.requirementHash,
    now: now(),
  });
  const price = formatUsd(decision.amountUsd);
  await ctx.audit.record({
    actor: "care",
    action: `x402.${decision.action}`,
    correlationId: ctx.correlationId,
    detail: {
      resource: requirement.resource,
      amountAtomic: requirement.maxAmountRequired,
      network: requirement.network,
      payTo: requirement.payTo,
      mandateId: mandate?.id ?? null,
      reasons: decision.reasons,
      requirementHash: decision.requirementHash,
    },
  });

  if (decision.action === "refuse") {
    return {
      ok: false,
      summary: `I won't pay for that: ${decision.reasons.join("; ")}.`,
      error: "x402_refused",
      data: { decision },
    };
  }

  // 4. Outside the standing limit: ask the person, bound to this exact requirement.
  if (decision.action === "needs_approval") {
    const quote = await ctx.memory.save(
      QUOTES,
      {
        query: request.query,
        tier: request.tier,
        requirement,
        requirementHash: decision.requirementHash,
        amountUsd: decision.amountUsd,
        status: "pending",
        expiresAt: now() + QUOTE_TTL_MS,
        reasons: decision.reasons,
      },
      { tags: ["x402", "quote"] },
    );
    const approval = await ctx.approvals.request({
      toolName: "approvePaidDataPurchase",
      toolInput: { quoteId: quote.id, requirementHash: decision.requirementHash },
      title: `Pay ${price} for product data`,
      description: `Care wants to buy a ${request.tier} ${request.query} comparison from ${service.name} for ${price} in test USDC. This needs your OK because ${decision.reasons.join("; ")}.`,
      correlationId: ctx.correlationId,
    });
    return {
      ok: true,
      summary: `That ${request.tier} comparison costs ${price}, which needs your approval (${decision.reasons.join("; ")}).`,
      approvalId: approval.id,
      data: { status: "awaiting_approval", quoteId: quote.id, amountUsd: decision.amountUsd },
    };
  }

  // 5. Pay: sign an EIP-3009 authorization and retry with X-PAYMENT.
  const wallet = getX402Wallet();
  let paid: Response;
  try {
    const payment = await wallet.signExact(requirement);
    paid = await transport(url.toString(), { [PAYMENT_HEADER]: encodeHeader(payment) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.audit.record({ actor: "care", action: "x402.payment_failed", correlationId: ctx.correlationId, detail: { error: message } });
    return { ok: false, summary: "The payment couldn't be completed, so nothing was charged.", error: message };
  }
  const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  const settlement = receiptHeader ? (() => { try { return decodeHeader<SettleResponse>(receiptHeader); } catch { return null; } })() : null;
  if (paid.status !== 200 || !settlement?.success) {
    const reason = paid.status === 402 ? String(((await paid.json().catch(() => ({}))) as { error?: string }).error ?? "rejected") : `http_${paid.status}`;
    await ctx.audit.record({ actor: "care", action: "x402.payment_failed", correlationId: ctx.correlationId, detail: { status: paid.status, reason } });
    return { ok: false, summary: "The service didn't accept the payment, so nothing was charged.", error: reason };
  }
  const result = (await paid.json()) as { comparison: Record<string, any>; settlement: "testnet" | "sandbox" };

  // 6. Record the cost.
  const entry = await ctx.memory.save(
    LEDGER,
    {
      service: service.id,
      serviceName: service.name,
      resource: requirement.resource,
      query: request.query,
      tier: request.tier,
      amountAtomic: requirement.maxAmountRequired,
      amountUsd: decision.amountUsd,
      asset: requirement.asset,
      network: requirement.network,
      payTo: requirement.payTo,
      payer: settlement.payer ?? wallet.address,
      walletBackend: wallet.backend,
      transaction: settlement.transaction,
      settlement: result.settlement,
      authorizedBy: decision.authorizedBy,
      mandateId: decision.authorizedBy === "mandate" ? mandate?.id ?? null : null,
      quoteId: approved?.quoteId ?? null,
      at: now(),
    },
    { tags: ["x402", "purchase", result.settlement] },
  );
  await ctx.audit.record({
    actor: "care",
    action: "x402.paid",
    correlationId: ctx.correlationId,
    detail: {
      purchaseId: entry.id,
      amountAtomic: requirement.maxAmountRequired,
      transaction: settlement.transaction,
      settlement: result.settlement,
      authorizedBy: decision.authorizedBy,
    },
  });
  await ctx.tasks.create({
    title: `Bought product data: ${result.comparison.category} (${price})`,
    steps: ["Quoted (402)", decision.authorizedBy === "approval" ? "Approved by you" : "Within standing limit", "Paid", "Data received"],
    status: "completed",
    result: describeComparison(result.comparison),
    correlationId: ctx.correlationId,
  });
  const receipt = await ctx.bus.publish({
    sourceAgent: "care",
    targetAgent: "finance",
    type: "x402.receipt",
    userId: ctx.userId,
    correlationId: ctx.correlationId,
    payload: {
      purchaseId: entry.id,
      service: service.name,
      amountUsd: decision.amountUsd,
      network: requirement.network,
      settlement: result.settlement,
      authorizedBy: decision.authorizedBy ?? "mandate",
    },
  });

  const how = result.settlement === "sandbox" ? "sandbox, no funds moved" : `Base Sepolia test USDC, tx ${settlement.transaction}`;
  return {
    ok: true,
    summary: `Paid ${price} (${how}) for a ${request.tier} ${result.comparison.category} comparison. ${describeComparison(result.comparison)}`,
    data: {
      comparison: result.comparison,
      purchase: {
        id: entry.id,
        amountUsd: decision.amountUsd,
        authorizedBy: decision.authorizedBy,
        transaction: settlement.transaction,
        settlement: result.settlement,
        payer: settlement.payer ?? wallet.address,
      },
      financeNotified: receipt.ok,
    },
  };
}

/** Run an approved quote exactly once, refusing stale, expired, or altered quotes. */
export async function executeApprovedQuote(ctx: ToolContext, input: ApprovedQuote): Promise<ToolResult> {
  const quote = await ctx.memory.get(input.quoteId);
  if (!quote || quote.collection !== QUOTES) {
    return { ok: false, summary: "That payment quote no longer exists.", error: "quote_not_found" };
  }
  if (quote.data.status !== "pending") {
    return { ok: false, summary: "That payment was already handled; I won't pay twice.", error: "quote_already_used" };
  }
  if (Number(quote.data.expiresAt) <= now()) {
    await ctx.memory.update(quote.id, { status: "expired" });
    return { ok: false, summary: "That approval expired. Ask me again for a fresh quote.", error: "quote_expired" };
  }
  if (quote.data.requirementHash !== input.requirementHash) {
    return { ok: false, summary: "The approved payment doesn't match the quote, so I didn't pay.", error: "quote_mismatch" };
  }
  // Consume before paying so a duplicate approval can never pay twice.
  await ctx.memory.update(quote.id, { status: "used", usedAt: now() });
  const result = await purchaseComparison(
    ctx,
    { query: String(quote.data.query), tier: quote.data.tier === "detailed" ? "detailed" : "basic" },
    input,
  );
  if (!result.ok) await ctx.memory.update(quote.id, { status: "failed", error: result.error ?? null });
  return result;
}
