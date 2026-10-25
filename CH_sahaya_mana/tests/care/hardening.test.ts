import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSahayaRuntime } from "@/agents";
import type { AgentContext } from "@/agents/base/types";
import type { CareAgent } from "@/agents/care/CareAgent";
import { NS } from "@/agents/care/repository";
import { DemoClock } from "@/agents/care/domain/time";
import { FileStore } from "@/lib/storage/FileStore";
import { ScriptedLLM, text, toolUse } from "../helpers";
import { careWorld } from "./careHelpers";

/** Synthetic people only. */
const ana: AgentContext = { userId: "user_ana", actor: { id: "user_ana", role: "older_adult" } };

async function fresh() {
  const llm = new ScriptedLLM();
  const w = await careWorld({ llm, seed: false });
  const turn = async (said: string, ...responses: ReturnType<typeof text>[]) => {
    llm.push(...responses);
    w.clock.advanceMinutes(1);
    return w.care.processMessage(ana, said);
  };
  const results = () => {
    const req = llm.requests.at(-1)!;
    const last = [...req.messages].reverse().find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    return last && Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result").map((b) => String((b as { content: unknown }).content)) : [];
  };
  return { llm, w, turn, results, facts: () => w.services().memory.list(ana.userId) };
}

describe("evidence binding through the real tools", () => {
  it("rejects a value the person didn't say (hallucinated)", async () => {
    const t = await fresh();
    await t.turn("I like oat milk", toolUse("rememberAboutUser", { kind: "grocery_preference", topic: "milk", value: "almond milk", userStatement: "I like oat milk" }), text("Oat milk — noted?"));
    expect(t.results()[0]).toMatch(/didn't say that/);
    expect(await t.facts()).toHaveLength(0);
  });

  it("rejects a negated allergy even when the quote omits the negation", async () => {
    const t = await fresh();
    await t.turn("I'm not allergic to peanuts, just so you know", toolUse("rememberAboutUser", { kind: "allergy", value: "peanuts", userStatement: "allergic to peanuts" }), text("Good to know."));
    expect(t.results()[0]).toMatch(/NOT allergic/);
    expect(await t.facts()).toHaveLength(0);
    expect((await t.w.services().env.repo.preferences(ana.userId))?.safety.allergies ?? []).toEqual([]);
  });

  it("saves the new preference in a correction, refuses the negated old one", async () => {
    const t = await fresh();
    const said = "I don't like Oatfield anymore, I prefer Meadow Mill";
    await t.turn(said, toolUse("rememberAboutUser", { kind: "brand_preference", topic: "milk", value: "Oatfield", userStatement: said }), text("Which do you prefer?"));
    expect(t.results()[0]).toMatch(/don't want or like/);
    await t.turn(said, toolUse("rememberAboutUser", { kind: "brand_preference", topic: "milk", value: "Meadow Mill", userStatement: said }), text("Meadow Mill it is."));
    expect((await t.facts()).map((f) => f.value)).toEqual(["Meadow Mill"]);
  });

  it("a hedged allergy is kept as reported-and-unsure, filters conservatively, and is labelled as unconfirmed", async () => {
    const t = await fresh();
    await t.turn("I think I might be allergic to sesame", toolUse("rememberAboutUser", { kind: "allergy", value: "sesame", userStatement: "allergic to sesame" }), text("Are you sure?"));
    expect(JSON.parse(t.results()[0])).toMatchObject({ status: "reported", hedged: true });
    await t.turn("show me crackers", toolUse("searchProducts", { query: "crackers" }), text("Here are some."));
    expect(JSON.parse(t.results()[0])).toMatchObject({ unconfirmedAllergiesApplied: ["sesame"] });
  });

  it("a name must be the person's own words", async () => {
    const t = await fresh();
    await t.turn("You can call me Annie", toolUse("rememberAboutUser", { kind: "address_as", value: "Anne-Marie", userStatement: "call me Annie" }), text("Annie?"));
    expect(t.results()[0]).toMatch(/exactly as the person said/);
  });
});

describe("complete forgetting of app-managed copies", () => {
  it("removes the value from conversation and tool payloads, notices and pending approvals, across a reload; keeps tool pairing", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sahaya-forget-")), "store.json");
    const llm = new ScriptedLLM();
    const clock = new DemoClock(1_800_000_000_000);
    const boot = () => {
      const store = new FileStore(path);
      const runtime = createSahayaRuntime({ store, llm, now: clock.now, integrationMode: () => "sandbox" });
      return { store, runtime, care: runtime.get("care") as CareAgent };
    };
    let a = boot();
    const turn = async (said: string, ...r: ReturnType<typeof text>[]) => {
      llm.push(...r);
      clock.advanceMinutes(1);
      return a.care.processMessage(ana, said);
    };
    await turn(
      "I always buy Meadow Mill oat milk",
      toolUse("rememberAboutUser", { kind: "usual_item", topic: "oat milk", value: "Meadow Mill oat milk", productId: "p_oat_meadow", userStatement: "I always buy Meadow Mill oat milk" }),
      text("Got it: Meadow Mill oat milk."),
    );
    // A pending, consent-type request that mentions it (synthetic).
    const pending = await a.care.requestApproval(ana, "requestPhysicalAssistance", { need: "grocery_pickup", summary: "Pick up Meadow Mill oat milk" });
    const [fact] = await a.care.listMemories(ana);
    await turn("Please forget the oat milk thing", toolUse("forgetMemory", { factId: fact.id, userStatement: "Please forget the oat milk thing" }), text("Done, I've forgotten that."));

    // Reload from disk, as after a restart.
    a = boot();
    const file = readFileSync(path, "utf8");
    expect(file).not.toContain("Meadow Mill oat milk");
    expect(await a.care.listMemories(ana)).toEqual([]);
    const ap = await a.store.getApproval(pending.id);
    expect(ap).toMatchObject({ status: "expired", summary: "Request withdrawn (details forgotten)", input: { forgotten: true } });
    const history = await a.care.listConversation(ana);
    expect(JSON.stringify(history)).not.toContain("Meadow Mill oat milk");
    const logs = await a.store.listLogs({ userId: ana.userId, agentId: "care" });
    expect(logs.find((l) => l.message === "Memory deleted")?.data).toMatchObject({ redactedMessages: expect.any(Number), invalidatedApprovals: 1 });
    expect(JSON.stringify(logs)).not.toContain("Meadow");

    // The next turn's replayed history is still valid (tool_use/tool_result pairs intact) and doesn't contain the value.
    await turn("What do you know about me?", toolUse("listMemories", {}), text("Nothing saved right now."));
    const req = llm.requests.at(-1)!;
    expect(JSON.stringify(req.messages)).not.toContain("Meadow Mill oat milk");
    const uses = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    const results = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(results.every((r) => uses.includes(r))).toBe(true);
  });

  it("a forgotten inferred habit is not re-learned from retained order history", async () => {
    const t = await fresh();
    const repo = t.w.services().env.repo;
    await t.w.services().memory.ensurePreferences(ana.userId);
    const order = (n: number) => ({
      id: `ord_${n}`,
      cartId: `c${n}`,
      cartHash: "h",
      lines: [{ productId: "p_oat_meadow", name: "Barista Oat Milk", quantity: 1, unitPriceCents: 429 }],
      totalCents: 928,
      deliveryWindow: { id: "w", label: "x", start: 0, end: 1 },
      status: "delivered" as const,
      statusHistory: [],
      placedAt: n,
      providerOrderId: "sbx",
      simulated: true,
      demo: false,
    });
    await repo.saveOrder(ana.userId, order(1));
    await repo.saveOrder(ana.userId, order(2));
    await t.w.services().memory.inferFromOrders(ana.userId);
    const [guess] = await t.facts();
    expect(guess.status).toBe("inferred");
    await t.w.care.deleteMemory(ana, guess.id);
    await repo.saveOrder(ana.userId, order(3));
    await t.w.services().memory.inferFromOrders(ana.userId);
    expect(await t.facts()).toEqual([]);
    // Orders are retained as transaction records; tombstones hold hashes only.
    expect(await repo.orders(ana.userId)).toHaveLength(3);
    const tombs = (await t.w.store.listMemory("care", ana.userId, NS.memory)).filter((r) => (r.value as { tombstone?: boolean }).tombstone);
    expect(tombs.length).toBeGreaterThan(0);
    expect(JSON.stringify(tombs)).not.toMatch(/oat|meadow/i);
    // Saying it again clears the tombstone (the person told us themselves).
    await t.turn("I buy Meadow Mill oat milk every week", toolUse("rememberAboutUser", { kind: "usual_item", topic: guess.topic, value: "Meadow Mill oat milk", productId: "p_oat_meadow", userStatement: "I buy Meadow Mill oat milk every week" }), text("Noted."));
    expect((await t.facts()).map((f) => f.status)).toEqual(["reported"]);
  });
});

describe("approval races and expiry", () => {
  async function pendingOrder() {
    const llm = new ScriptedLLM();
    const w = await careWorld({ llm });
    const margaret = { userId: "user_margaret_demo", actor: { id: "user_margaret_demo", role: "older_adult" as const } };
    const built = await w.care.executeTool(margaret, "createGroceryList", { includeUsualItems: false, additionalItems: ["bread"] });
    const cartId = (built as { output: { cartId: string } }).output.cartId;
    const cart = (await w.services().env.repo.carts(margaret.userId)).at(-1)!;
    for (const a of cart.pendingAdditions) await w.care.executeTool(margaret, "respondToCartSuggestion", { cartId, suggestionId: a.id, decision: "decline" });
    const review = (await w.care.executeTool(margaret, "reviewCart", { cartId })) as { output: { cartHash: string; totals: { totalCents: number }; deliveryWindow: { id: string } } };
    const input = { cartId, cartHash: review.output.cartHash, totalCents: review.output.totals.totalCents, deliveryWindowId: review.output.deliveryWindow.id };
    const res = await w.care.executeTool(margaret, "requestOrderApproval", input);
    if (res.status !== "approval_required") throw new Error("expected approval");
    return { w, margaret, approval: res.approval, input };
  }

  it("two simultaneous approvals execute the order exactly once", async () => {
    const { w, margaret, approval } = await pendingOrder();
    const settled = await Promise.allSettled([w.care.decide(margaret, approval.id, "approve"), w.care.decide(margaret, approval.id, "approve")]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);
    expect(await w.services().env.repo.orders(margaret.userId)).toHaveLength(1);
  });

  it("approve vs deny race: only one decision wins", async () => {
    const { w, margaret, approval } = await pendingOrder();
    const settled = await Promise.allSettled([w.care.decide(margaret, approval.id, "deny"), w.care.decide(margaret, approval.id, "approve")]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const final = await w.store.getApproval(approval.id);
    const orders = await w.services().env.repo.orders(margaret.userId);
    expect(final!.status === "denied" ? orders.length === 0 : orders.length === 1).toBe(true);
  });

  it("an approval that expires after being approved can't be executed or replayed", async () => {
    const { w, margaret, approval, input } = await pendingOrder();
    await w.store.transitionApproval(approval.id, "pending", { status: "approved", decidedAt: w.clock.now(), decidedBy: margaret.actor.id });
    w.clock.advanceMinutes(25 * 60);
    const res = await w.care.executeTool({ userId: margaret.userId, actor: { id: "agent:care", role: "system" } }, "requestOrderApproval", input, { approvalId: approval.id });
    expect(res).toMatchObject({ status: "error", code: "APPROVAL_INVALID" });
    expect(await w.services().env.repo.orders(margaret.userId)).toHaveLength(0);
  });
});
