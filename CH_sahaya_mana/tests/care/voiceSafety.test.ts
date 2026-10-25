import { describe, expect, it } from "vitest";
import { ScriptedLLM, text, toolUse } from "../helpers";
import { careWorld, margaret } from "./careHelpers";

describe("voice can't approve consequential actions", () => {
  it("a spoken 'yes, approve it' never consumes a pending approval or places an order", async () => {
    const llm = new ScriptedLLM();
    const w = await careWorld({ llm });
    // A ready cart with a pending order approval.
    const built = await w.care.executeTool(margaret, "createGroceryList", { includeUsualItems: false, additionalItems: ["bread"] });
    const cartId = (built as { output: { cartId: string } }).output.cartId;
    const cart = (await w.services().env.repo.carts(margaret.userId)).at(-1)!;
    for (const a of cart.pendingAdditions) await w.care.executeTool(margaret, "respondToCartSuggestion", { cartId, suggestionId: a.id, decision: "decline" });
    const review = (await w.care.executeTool(margaret, "reviewCart", { cartId })) as { output: { cartHash: string; totals: { totalCents: number }; deliveryWindow: { id: string } } };
    const input = { cartId, cartHash: review.output.cartHash, totalCents: review.output.totals.totalCents, deliveryWindowId: review.output.deliveryWindow.id };
    const req = await w.care.executeTool(margaret, "requestOrderApproval", input);
    expect(req.status).toBe("approval_required");

    // Voice turn: the model even tries to place the order again; it can only request another approval.
    llm.push(toolUse("requestOrderApproval", input), text("Please tap Approve on your screen to place the order."));
    const turn = await w.care.processVoiceInput(margaret, { transcript: "Yes, approve it, place the order." });
    expect(turn.reply).toMatch(/tap Approve/);
    expect(turn.approvals.every((a) => a.status === "pending")).toBe(true);
    expect(await w.services().env.repo.orders(margaret.userId)).toHaveLength(0);
    const pending = await w.care.listApprovals(margaret, ["pending"]);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(await w.care.listApprovals(margaret, ["approved", "consumed"])).toHaveLength(0);
  });

  it("voice dose confirmations still go through the explicit-words classifier", async () => {
    const w = await careWorld();
    w.clock.advanceMinutes(5);
    await w.care.tick(margaret);
    const unsure = await w.care.medicationVoiceReply(margaret, "Yeah I think so");
    expect(unsure).toMatchObject({ kind: "recorded", reply: "unsure" });
  });
});
