import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import {
  createWallet,
  encodeHeader,
  LocalVerifierFacilitator,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  decodeHeader,
  setFacilitator,
  setX402Wallet,
  X402_NETWORKS,
  type PaymentRequirements,
  type SettleResponse,
} from "@/integrations/x402";
import { x402Status } from "@/lib/env";
import { evaluateX402Payment, requirementHash, type SpendingMandate } from "@/agents/care/paidServices/x402Policy";
import { productCompareService, findServiceForResource, IN_PROCESS_ORIGIN, PRODUCT_COMPARE_PATH } from "@/agents/care/paidServices/registry";
import { handleProductCompare, requirementsFor } from "@/agents/care/paidServices/productCompareService";
import { LEDGER, QUOTES, setTransport } from "@/agents/care/paidServices/paidServiceWorkflow";

const USER = "user-x402";
const RESOURCE = `${IN_PROCESS_ORIGIN}${PRODUCT_COMPARE_PATH}?q=oats&tier=basic`;

function mandate(over: Partial<SpendingMandate> = {}): SpendingMandate {
  return {
    id: "m1",
    perPaymentLimitUsd: 0.05,
    dailyLimitUsd: 0.25,
    allowedServiceIds: ["product-compare"],
    network: "base-sepolia",
    grantedBy: "user",
    grantedAt: 0,
    ...over,
  };
}

function req(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return { ...requirementsFor(RESOURCE, "basic"), ...over };
}

function decide(r: PaymentRequirements, opts: { mandate?: SpendingMandate | null; spent?: bigint; approvedHash?: string } = {}) {
  return evaluateX402Payment({
    requirement: r,
    service: findServiceForResource(r.resource),
    mandate: opts.mandate === undefined ? mandate() : opts.mandate,
    spentTodayAtomic: opts.spent ?? 0n,
    approvedHash: opts.approvedHash,
    now: Date.now(),
  });
}

beforeEach(() => {
  delete process.env.X402_WALLET_PRIVATE_KEY;
  delete process.env.X402_PAY_TO;
  delete process.env.X402_SERVICE_URL;
  setX402Wallet(null);
  setFacilitator(null);
  setTransport(null);
});
afterEach(() => setTransport(null));

describe("x402 policy (pure, deterministic)", () => {
  it("pays automatically within the previously authorized limit", () => {
    const d = decide(req());
    expect(d.action).toBe("pay");
    expect(d.authorizedBy).toBe("mandate");
    expect(d.amountUsd).toBe(0.01);
  });

  it("asks for approval above the per-payment limit, the daily limit, or with no mandate", () => {
    expect(decide(req({ maxAmountRequired: "100000" })).action).toBe("needs_approval");
    expect(decide(req(), { spent: 245000n }).action).toBe("needs_approval");
    expect(decide(req(), { mandate: null }).action).toBe("needs_approval");
    expect(decide(req(), { mandate: mandate({ expiresAt: 1 }) }).action).toBe("needs_approval");
  });

  it("an approval covers exactly the approved terms, nothing else", () => {
    const over = req({ maxAmountRequired: "100000" });
    expect(decide(over, { approvedHash: requirementHash(over) })).toMatchObject({ action: "pay", authorizedBy: "approval" });
    const requoted = req({ maxAmountRequired: "200000" });
    expect(decide(requoted, { approvedHash: requirementHash(over) }).action).toBe("refuse");
  });

  it("refuses mainnet, foreign assets, wrong payees and unregistered resources even when approved", () => {
    const base = X402_NETWORKS.base;
    const mainnet = req({ network: "base", asset: base.usdc });
    expect(decide(mainnet, { approvedHash: requirementHash(mainnet) }).action).toBe("refuse");
    expect(decide(req({ asset: "0x0000000000000000000000000000000000000001" })).action).toBe("refuse");
    const thief = req({ payTo: "0x000000000000000000000000000000000000bEEF" });
    expect(decide(thief, { approvedHash: requirementHash(thief) }).action).toBe("refuse");
    expect(decide(req({ resource: "https://evil.example/api/x402/product-compare?q=oats" })).action).toBe("refuse");
    expect(decide(req({ maxAmountRequired: "2000000" }), { approvedHash: "x" }).action).toBe("refuse");
  });

  it("never pays a checkout-category service: x402 is not a grocery checkout", () => {
    const r = req();
    const checkout = { ...productCompareService(), id: "grocer-checkout", category: "checkout" as const };
    const d = evaluateX402Payment({ requirement: r, service: checkout, mandate: mandate(), spentTodayAtomic: 0n, approvedHash: requirementHash(r), now: Date.now() });
    expect(d.action).toBe("refuse");
    expect(d.reasons.join(" ")).toMatch(/not a checkout/);
  });
});

describe("x402 protocol: EIP-3009 authorization signing + verification", () => {
  it("a signed payment verifies, then cannot be replayed", async () => {
    const wallet = createWallet(generatePrivateKey(), "ephemeral");
    const facilitator = new LocalVerifierFacilitator();
    const r = req();
    const payment = await wallet.signExact(r);
    expect(await facilitator.verify(payment, r)).toMatchObject({ isValid: true, payer: wallet.address });
    expect((await facilitator.settle(payment, r)).success).toBe(true);
    expect(await facilitator.verify(payment, r)).toMatchObject({ isValid: false, invalidReason: "nonce_already_used" });
  });

  it("rejects tampered amounts, wrong recipients, and forged signers", async () => {
    const wallet = createWallet(generatePrivateKey(), "ephemeral");
    const facilitator = new LocalVerifierFacilitator();
    const r = req();
    const payment = await wallet.signExact(r);
    const tampered = structuredClone(payment);
    tampered.payload.authorization.value = "1";
    expect((await facilitator.verify(tampered, r)).invalidReason).toBe("wrong_amount");
    const higher = req({ maxAmountRequired: "1" });
    expect((await facilitator.verify(tampered, higher)).invalidReason).toBe("invalid_signature");
    const forged = structuredClone(payment);
    forged.payload.authorization.from = createWallet(generatePrivateKey(), "ephemeral").address;
    expect((await facilitator.verify(forged, r)).invalidReason).toBe("invalid_signature");
    expect((await facilitator.verify(payment, req({ payTo: "0x000000000000000000000000000000000000bEEF" }))).invalidReason).toBe("wrong_recipient");
  });
});

describe("x402 seller: product-compare service", () => {
  it("answers 402 with x402 payment requirements, then 200 + receipt once paid", async () => {
    const res = await handleProductCompare(new Request(`${IN_PROCESS_ORIGIN}${PRODUCT_COMPARE_PATH}?q=oatmeal&tier=basic`));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "base-sepolia", maxAmountRequired: "10000", mimeType: "application/json" });

    const wallet = createWallet(generatePrivateKey(), "ephemeral");
    const payment = await wallet.signExact(body.accepts[0]);
    const paid = await handleProductCompare(
      new Request(`${IN_PROCESS_ORIGIN}${PRODUCT_COMPARE_PATH}?q=oatmeal&tier=basic`, { headers: { [PAYMENT_HEADER]: encodeHeader(payment) } }),
    );
    expect(paid.status).toBe(200);
    const receipt = decodeHeader<SettleResponse>(paid.headers.get(PAYMENT_RESPONSE_HEADER)!);
    expect(receipt).toMatchObject({ success: true, network: "base-sepolia", payer: wallet.address });
    expect(receipt.transaction).toMatch(/^sandbox:/);
    expect((await paid.json()).comparison.bestValue.name).toBe("Organic Rolled Oats");
  });

  it("does not charge for products it has no data on", async () => {
    const res = await handleProductCompare(new Request(`${IN_PROCESS_ORIGIN}${PRODUCT_COMPARE_PATH}?q=caviar`));
    expect(res.status).toBe(404);
  });

  it("reports sandbox honestly without a funded test wallet", () => {
    expect(x402Status().mode).toBe("sandbox");
    process.env.X402_WALLET_PRIVATE_KEY = generatePrivateKey();
    process.env.X402_PAY_TO = "0x000000000000000000000000000000000000bEEF";
    expect(x402Status().mode).toBe("live");
  });
});

describe("Care x402 workflow end to end", () => {
  it("small authorized test payment unlocks a comparison, records the cost, and receipts Finance", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();

    const { reply } = await service.sendMessage("care", "Compare oats for the best value");
    const call = reply.toolCalls.find((c) => c.toolName === "compareProducts")!;
    expect(call.status).toBe("success");
    expect(reply.approvalsRequested).toHaveLength(0);
    expect((call.output as any).comparison.bestValue.name).toBe("Organic Rolled Oats");
    expect((call.output as any).purchase).toMatchObject({ amountUsd: 0.01, authorizedBy: "mandate", settlement: "sandbox" });

    const care = createAgent("care", { data, userId: USER });
    const ledger = await care.memory.list(LEDGER);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].data).toMatchObject({ amountAtomic: "10000", network: "base-sepolia", authorizedBy: "mandate" });

    const audit = (await care.audit.list()).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["x402.pay", "x402.paid"]));

    const financeTasks = await data.tasks.list({ userId: USER, agentId: "finance" });
    expect(financeTasks.some((t) => t.title.startsWith("Paid data service: $0.01"))).toBe(true);
  });

  it("over the limit: asks for approval, pays only once approved, and never twice", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();

    const { reply } = await service.sendMessage("care", "Which soup is healthiest? I need low sodium");
    expect(reply.approvalsRequested).toHaveLength(1);
    const care = createAgent("care", { data, userId: USER });
    expect(await care.memory.list(LEDGER)).toHaveLength(0);

    const approvalId = reply.approvalsRequested[0];
    const decided = await service.decideApproval("care", approvalId, "approve");
    expect(decided.record?.status).toBe("success");
    expect((decided.record?.output as any).purchase).toMatchObject({ amountUsd: 0.1, authorizedBy: "approval" });
    expect((decided.record?.output as any).comparison.recommended.name).toBe("Low-Sodium Vegetable Soup");
    expect(await care.memory.list(LEDGER)).toHaveLength(1);

    // Replaying the approved tool call is refused: the quote is single-use.
    const approval = await data.approvals.get(approvalId);
    const replay = await care.executeTool("approvePaidDataPurchase", approval!.input, { approved: true });
    expect(replay.result).toMatchObject({ ok: false, error: "quote_already_used" });
    expect(await care.memory.list(LEDGER)).toHaveLength(1);
  });

  it("rejecting the approval spends nothing", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();
    const { reply } = await service.sendMessage("care", "compare yogurt nutrition in detail");
    await service.decideApproval("care", reply.approvalsRequested[0], "reject");
    const care = createAgent("care", { data, userId: USER });
    expect(await care.memory.list(LEDGER)).toHaveLength(0);
  });

  it("refuses to pay if the service raises the price after approval", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();
    const { reply } = await service.sendMessage("care", "compare bread nutrition in detail");

    setTransport({
      origin: IN_PROCESS_ORIGIN,
      transport: async (url, headers) => {
        const res = await handleProductCompare(new Request(url, { headers }));
        if (res.status !== 402) return res;
        const body = await res.json();
        body.accepts[0].maxAmountRequired = "150000";
        return new Response(JSON.stringify(body), { status: 402 });
      },
    });
    const decided = await service.decideApproval("care", reply.approvalsRequested[0], "approve");
    expect(decided.record?.status).toBe("error");
    expect(decided.record?.summary).toMatch(/payment terms changed/);
    const care = createAgent("care", { data, userId: USER });
    expect(await care.memory.list(LEDGER)).toHaveLength(0);
    const quote = (await care.memory.list(QUOTES))[0];
    expect(quote.data.status).toBe("failed");
  });

  it("a failed settlement records no spend", async () => {
    const data = createInMemoryDataLayer();
    const care = createAgent("care", { data, userId: USER });
    await care.initialize();
    setFacilitator({
      backend: "local-verifier",
      verify: async () => ({ isValid: true }),
      settle: async (_p, r) => ({ success: false, transaction: "", network: r.network, errorReason: "insufficient_funds" }),
    });
    const res = await care.executeTool("compareProducts", { query: "milk" });
    expect(res.result.ok).toBe(false);
    expect(await care.memory.list(LEDGER)).toHaveLength(0);
  });

  it("changing the standing limit itself requires approval", async () => {
    const data = createInMemoryDataLayer();
    const care = createAgent("care", { data, userId: USER });
    await care.initialize();
    const res = await care.executeTool("setPaidServiceLimit", { perPaymentLimitUsd: 0.5, dailyLimitUsd: 2 });
    expect(res.record.status).toBe("awaiting_approval");
    expect((await care.executeTool("setPaidServiceLimit", { perPaymentLimitUsd: 5, dailyLimitUsd: 2 }, { approved: true })).result.ok).toBe(false);
  });
});
