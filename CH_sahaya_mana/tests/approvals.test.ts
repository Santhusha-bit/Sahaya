import { describe, expect, it } from "vitest";
import { CAREGIVER, ScriptedLLM, USER, caregiverCtx, testRuntime, text, toolUse, userCtx } from "./helpers";

describe("approval gating for sensitive actions", () => {
  it("does not run a sensitive tool until approved, then runs it exactly once", async () => {
    const llm = new ScriptedLLM([toolUse("placeOrder", { cartId: "c1", totalCents: 4200 }), text("Please approve.")]);
    const { runtime, calls } = testRuntime(llm);
    const care = runtime.get("care");

    const turn = await care.processMessage(userCtx, "order my groceries");
    expect(turn.approvals).toHaveLength(1);
    expect(calls.placeOrder).toBeUndefined();
    const approval = turn.approvals[0];
    expect(approval).toMatchObject({ status: "pending", summary: "Order c1 for 4200", agentId: "care" });
    expect((await care.getTaskStatus(userCtx, turn.taskId!)).status).toBe("awaiting_approval");

    const { result } = await runtime.resolveApproval(userCtx, approval.id, "approve");
    expect(result).toMatchObject({ status: "success", output: { orderId: "ord_c1" } });
    expect(calls.placeOrder).toHaveLength(1);
    expect((await care.getTaskStatus(userCtx, turn.taskId!)).status).toBe("completed");

    // Consumed approvals cannot be replayed.
    await expect(runtime.resolveApproval(userCtx, approval.id, "approve")).rejects.toThrow(/already consumed/);
    const replay = await care.executeTool(userCtx, "placeOrder", { cartId: "c1", totalCents: 4200 }, { approvalId: approval.id });
    expect(replay).toMatchObject({ status: "error", code: "APPROVAL_INVALID" });
    expect(calls.placeOrder).toHaveLength(1);
  });

  it("an approval cannot authorize different arguments", async () => {
    const { runtime, calls } = testRuntime();
    const care = runtime.get("care");
    const first = await care.executeTool(userCtx, "placeOrder", { cartId: "c1", totalCents: 100 });
    if (first.status !== "approval_required") throw new Error("expected approval");
    // Mark approved without executing, then try to use it for a bigger order.
    const store = (care as unknown as { store: { saveApproval: (a: unknown) => Promise<void> } }).store;
    await store.saveApproval({ ...first.approval, status: "approved" });
    const res = await care.executeTool(userCtx, "placeOrder", { cartId: "c1", totalCents: 99999 }, { approvalId: first.approval.id });
    expect(res).toMatchObject({ status: "error", code: "APPROVAL_INVALID" });
    expect(calls.placeOrder).toBeUndefined();
  });

  it("an approval for one agent cannot be used by another", async () => {
    const { runtime } = testRuntime();
    const first = await runtime.get("care").executeTool(userCtx, "placeOrder", { cartId: "c1", totalCents: 100 });
    if (first.status !== "approval_required") throw new Error("expected approval");
    await expect(runtime.get("guardian").resolveApproval(userCtx, first.approval.id, "approve")).rejects.toThrow(/another agent/);
  });

  it("denial skips the step and never runs the tool", async () => {
    const { runtime, calls } = testRuntime();
    const care = runtime.get("care");
    const task = await care.planTask(userCtx, "noop");
    const step = task.steps[0];
    const res = await care.executeTool(userCtx, "placeOrder", { cartId: "c2", totalCents: 5 }, { taskId: task.id, stepId: step.id });
    if (res.status !== "approval_required") throw new Error("expected approval");
    await runtime.resolveApproval(userCtx, res.approval.id, "deny");
    const after = await care.getTaskStatus(userCtx, task.id);
    expect(after.steps[0].status).toBe("skipped");
    expect(calls.placeOrder).toBeUndefined();
  });

  it("caregivers need an explicit canApprove grant for that agent", async () => {
    const { runtime, store } = testRuntime();
    const res = await runtime.get("care").executeTool(userCtx, "placeOrder", { cartId: "c3", totalCents: 5 });
    if (res.status !== "approval_required") throw new Error("expected approval");
    await expect(runtime.resolveApproval(caregiverCtx, res.approval.id, "approve")).rejects.toThrow(/may not approve/);

    await store.setCaregiverPermission({ userId: USER, caregiverId: CAREGIVER, agentId: "finance", canApprove: true, canViewSummaries: true });
    await expect(runtime.resolveApproval(caregiverCtx, res.approval.id, "approve")).rejects.toThrow(/may not approve/);

    await store.setCaregiverPermission({ userId: USER, caregiverId: CAREGIVER, agentId: "care", canApprove: true, canViewSummaries: true });
    const { approval } = await runtime.resolveApproval(caregiverCtx, res.approval.id, "approve");
    expect(approval.decidedBy).toBe(CAREGIVER);
  });

  it("expired approvals cannot be approved", async () => {
    const { runtime } = testRuntime();
    const care = runtime.get("care");
    const res = await care.executeTool(userCtx, "placeOrder", { cartId: "c4", totalCents: 5 });
    if (res.status !== "approval_required") throw new Error("expected approval");
    const store = (care as unknown as { store: { saveApproval: (a: unknown) => Promise<void> } }).store;
    await store.saveApproval({ ...res.approval, expiresAt: Date.now() - 1 });
    await expect(runtime.resolveApproval(userCtx, res.approval.id, "approve")).rejects.toThrow(/expired/);
  });

  it("tells the agent about the decision on its next turn", async () => {
    const llm = new ScriptedLLM([toolUse("placeOrder", { cartId: "c5", totalCents: 5 }), text("Approve please."), text("Done!")]);
    const { runtime } = testRuntime(llm);
    const care = runtime.get("care");
    const turn = await care.processMessage(userCtx, "order");
    await runtime.resolveApproval(userCtx, turn.approvals[0].id, "approve");
    await care.processMessage(userCtx, "did it go through?");
    const last = JSON.stringify(llm.requests.at(-1)!.messages.at(-1));
    expect(last).toContain("APPROVED");
    expect(last).toContain("ord_c5");
  });
});
