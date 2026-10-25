import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { createSandboxNessieClient } from "@/integrations/nessie";
import { findDuplicateCharges, findSubscriptions, type BankTransaction } from "@/agents/finance/nessie/analysis";
import { claudeReviewer, rulesReviewer } from "@/agents/finance/nessie/classify";
import {
  BankNotAuthorizedError,
  connectBank,
  currentSuggestions,
  decideSuggestion,
  fetchAuthorizedTransactions,
  revokeBank,
  runSpendingAnalysis,
  simulateNewPurchase,
} from "@/agents/finance/nessie/service";

const TODAY = "2026-10-24";

async function setup() {
  const data = createInMemoryDataLayer();
  const finance = createAgent("finance", { data, userId: "u-nessie" });
  await finance.initialize();
  const nessie = createSandboxNessieClient();
  const deps = { memory: finance.memory, nessie, reviewer: rulesReviewer(), tasks: finance.taskService, today: TODAY };
  return { data, finance, nessie, deps };
}

describe("Nessie spending analysis", () => {
  it("finds the fixture's subscriptions and price increase, and ignores look-alikes", async () => {
    const { deps } = await setup();
    await connectBank(deps);
    const { analysis } = await runSpendingAnalysis(deps);

    const subs = Object.fromEntries(analysis.subscriptions.map((s) => [s.merchant, s]));
    expect(Object.keys(subs).sort()).toEqual(["Bay Internet", "CloudPhotos Plus", "Daily Gazette", "FitLife Gym", "StreamTV"]);
    expect(subs["Daily Gazette"].priceIncrease).toBe(true);
    expect(subs["Daily Gazette"].previousAmount).toBe(9.99);
    expect(subs["Daily Gazette"].monthlyAmount).toBe(12.99);
    expect(subs["StreamTV"].priceIncrease).toBe(false);
    // Weekly groceries, a varying utility bill, pharmacy refills and a diner are not subscriptions.
    for (const m of ["Safeway", "PG&E", "CVS Pharmacy", "Mel's Diner"]) expect(subs[m]).toBeUndefined();
    expect(analysis.duplicates).toHaveLength(0);

    expect(analysis.month).toBe("2026-10");
    expect(analysis.summary.previousMonth).toBe("2026-09");
    expect(analysis.summary.total).toBeCloseTo(502.06, 2);
    expect(analysis.summary.previousTotal).toBeCloseTo(505.74, 2);
    expect(analysis.summary.byCategory[0].category).toBe("groceries");
    expect(analysis.summary.recurringMonthlyTotal).toBeCloseTo(121.95, 2);
    expect(analysis.firstRun).toBe(true);
    expect(analysis.newTransactions).toHaveLength(0);

    const kinds = (await currentSuggestions(deps.memory)).map((s) => s.kind);
    expect(kinds.filter((k) => k === "review_subscription")).toHaveLength(5);
    expect(kinds).toContain("check_price_increase");
  });

  it("detects a newly added sandbox transaction as new and as a possible double charge on the next run", async () => {
    const { deps, nessie } = await setup();
    const { connection } = await connectBank(deps);
    await runSpendingAnalysis(deps);
    const before = (await nessie.listPurchases(connection.accountId)).length;

    const { merchant } = await simulateNewPurchase(deps, { scenario: "double_charge" });
    expect(merchant).toBe("Safeway"); // the latest fixture purchase (Oct 23)
    expect((await nessie.listPurchases(connection.accountId)).length).toBe(before + 1);

    const { analysis } = await runSpendingAnalysis(deps);
    expect(analysis.firstRun).toBe(false);
    expect(analysis.newTransactions).toHaveLength(1);
    expect(analysis.newTransactions[0]).toMatchObject({ merchant: "Safeway", amount: 44.6, flags: ["possible duplicate"] });
    expect(analysis.duplicates).toHaveLength(1);
    expect(analysis.spoken).toMatch(/1 new charge.*Safeway.*\$44\.60.*charged twice/);
    const dispute = (await currentSuggestions(deps.memory)).find((s) => s.kind === "dispute_duplicate");
    expect(dispute?.title).toContain("Safeway $44.60");

    // A custom purchase is also picked up on the following run.
    await simulateNewPurchase(deps, { scenario: "custom", merchant: "Corner Bookshop", amount: 18.5 });
    const third = (await runSpendingAnalysis(deps)).analysis;
    expect(third.newTransactions.map((t) => t.merchant)).toEqual(["Corner Bookshop"]);
  });

  it("remembers decisions across runs; accepting a duplicate only drafts a dispute", async () => {
    const { deps, nessie, finance } = await setup();
    const { connection } = await connectBank(deps);
    await runSpendingAnalysis(deps);
    const stream = (await currentSuggestions(deps.memory)).find((s) => s.title.includes("StreamTV"))!;
    await decideSuggestion(deps, stream.id, "dismiss");

    await simulateNewPurchase(deps, { scenario: "double_charge" });
    await runSpendingAnalysis(deps);
    const now = await currentSuggestions(deps.memory);
    expect(now.find((s) => s.key === stream.key)?.status).toBe("dismissed");

    const purchasesBefore = (await nessie.listPurchases(connection.accountId)).length;
    const dup = now.find((s) => s.kind === "dispute_duplicate")!;
    const { outcome, disputeId } = await decideSuggestion(deps, dup.id, "accept");
    expect(outcome).toMatch(/not sent/);
    expect((await finance.memory.get(disputeId!))?.data.status).toBe("drafted");
    expect((await nessie.listPurchases(connection.accountId)).length).toBe(purchasesBefore);
    expect(await finance.memory.list("financialActions")).toHaveLength(0);
    // Deciding twice is a no-op.
    expect((await decideSuggestion(deps, dup.id, "dismiss")).outcome).toMatch(/Already accepted/);

    const sub = now.find((s) => s.kind === "review_subscription" && s.status === "suggested")!;
    await decideSuggestion(deps, sub.id, "accept");
    expect((await finance.taskService.list()).some((t) => t.title.startsWith(`Cancel ${sub.merchant}`))).toBe(true);
  });

  it("refuses to read the bank before authorization and after revocation", async () => {
    const { deps } = await setup();
    await expect(fetchAuthorizedTransactions(deps)).rejects.toBeInstanceOf(BankNotAuthorizedError);
    await expect(runSpendingAnalysis(deps)).rejects.toBeInstanceOf(BankNotAuthorizedError);
    await connectBank(deps);
    expect((await fetchAuthorizedTransactions(deps)).transactions.length).toBeGreaterThan(30);
    expect(await revokeBank(deps.memory)).toBe(true);
    await expect(fetchAuthorizedTransactions(deps)).rejects.toBeInstanceOf(BankNotAuthorizedError);
  });

  it("stores only the last 4 digits of the account number", async () => {
    const { deps, data } = await setup();
    await connectBank(deps);
    await runSpendingAnalysis(deps);
    const rows = await data.memory.list({ namespace: "finance", userId: "u-nessie" });
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/\b4\d{15}\b/);
    expect(rows.some((r) => r.collection === "spendingAnalyses")).toBe(true);
  });
});

describe("Finance agent + Nessie tools", () => {
  it("connecting needs the person's approval; analysis then runs through the agent", async () => {
    const data = createInMemoryDataLayer();
    const USER = "u-nessie-agent";
    const service = new AgentService(data, USER);
    await service.initializeAll();

    const first = await service.sendMessage("finance", "What subscriptions am I paying for?");
    expect(first.reply.toolCalls[0]).toMatchObject({ toolName: "connectSandboxBankAccount", status: "awaiting_approval" });
    const finance = createAgent("finance", { data, userId: USER });
    expect(await finance.memory.list("bankConnections")).toHaveLength(0);

    const blocked = await finance.executeTool("runSpendingAnalysis", {});
    expect(blocked.result).toMatchObject({ ok: false, error: "bank_not_authorized" });

    const [approval] = (await service.agentState("finance")).approvals;
    const decided = await service.decideApproval("finance", approval.id, "approve");
    expect(decided.record?.status).toBe("success");
    expect(decided.record?.summary).toMatch(/Connected Everyday Checking ending \d{4}/);

    const second = await service.sendMessage("finance", "What subscriptions am I paying for?");
    const call = second.reply.toolCalls[0];
    expect(call).toMatchObject({ toolName: "runSpendingAnalysis", status: "success" });
    expect(call.summary).toMatch(/regular monthly charges/);
  });

  it("Finance has no tool that creates bank purchases, and other agents have no bank tools", () => {
    const data = createInMemoryDataLayer();
    const names = (id: "finance" | "care" | "guardian" | "wellness") =>
      createAgent(id, { data, userId: "x" }).tools.map((t) => t.name);
    expect(names("finance")).toEqual(expect.arrayContaining(["connectSandboxBankAccount", "runSpendingAnalysis", "reviewSuggestedAction"]));
    expect(names("finance").some((n) => /simulate|purchase|transfer|pay/i.test(n))).toBe(false);
    for (const other of ["care", "guardian", "wellness"] as const) {
      expect(names(other)).not.toContain("runSpendingAnalysis");
      expect(names(other)).not.toContain("fetchBankTransactions");
    }
  });
});

describe("Claude transaction reviewer", () => {
  const txns: BankTransaction[] = [
    { id: "aaa111", date: "2026-10-03", amount: 15.99, merchant: "StreamTV", bankCategory: "Streaming", status: "completed" },
    { id: "bbb222", date: "2026-10-09", amount: 55.48, merchant: "Safeway", bankCategory: "Grocery", status: "completed" },
    { id: "ccc333", date: "2026-10-09", amount: 55.48, merchant: "Safeway", bankCategory: "Grocery", status: "completed" },
    { id: "ddd444", date: "2026-10-12", amount: 59.99, merchant: "Bay Internet", status: "completed" },
  ];

  function fakeClient(input: unknown, capture: { body?: string } = {}) {
    return {
      messages: {
        create: async (params: { messages: { content: string }[] }) => {
          capture.body = params.messages[0].content;
          return {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "tu_1", name: "report_transaction_review", input }],
          };
        },
      },
    } as unknown as Anthropic;
  }

  it("uses valid Claude labels, falls back to rules for invalid ones, and drops notes for unknown keys", async () => {
    const duplicates = findDuplicateCharges(txns);
    const subscriptions = findSubscriptions(txns);
    const capture: { body?: string } = {};
    const review = await claudeReviewer(
      fakeClient(
        {
          categories: [
            { ref: "t1", category: "entertainment" },
            { ref: "t2", category: "groceries" },
            { ref: "t3", category: "luxury_yachts" }, // not an allowed category
            { ref: "t99", category: "dining" }, // unknown transaction
          ],
          duplicateNotes: [
            { key: duplicates[0].key, note: "Two identical Safeway charges on the same day; check your receipt." },
            { key: "dup:made:up", note: "invented" },
          ],
          subscriptionNotes: [],
        },
        capture,
      ),
    )({ transactions: txns, duplicates, subscriptions });

    expect(review.reviewer).toBe("claude");
    const byId = Object.fromEntries(review.transactions.map((t) => [t.id, t]));
    expect(byId.aaa111).toMatchObject({ category: "entertainment", categorySource: "claude" });
    expect(byId.ccc333).toMatchObject({ category: "groceries", categorySource: "rules" });
    expect(byId.ddd444).toMatchObject({ category: "phone_internet", categorySource: "rules" });
    expect(review.duplicateNotes).toEqual({ [duplicates[0].key]: expect.stringContaining("Safeway") });
    expect(review.reviewerNote).toMatch(/2 transaction\(s\) fell back/);
    // Data minimization: Claude never sees bank transaction ids.
    expect(capture.body).not.toContain("aaa111");
    expect(capture.body).toContain('"ref":"t1"');
  });

  it("falls back to rules entirely when Claude returns no usable report", async () => {
    const review = await claudeReviewer(fakeClient({ categories: "nope" }))({ transactions: txns, duplicates: [], subscriptions: [] });
    expect(review.reviewer).toBe("rules");
    expect(review.transactions.every((t) => t.categorySource === "rules")).toBe(true);
  });
});
