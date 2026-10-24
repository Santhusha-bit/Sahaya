import { describe, expect, it } from "vitest";
import {
  SandboxWorkItemStore,
  WorkItemService,
  hashInput,
  type CreateWorkItemInput,
} from "@/agents/base/workItems";

const USER = "user-wi";

function baseProposal(): CreateWorkItemInput {
  return {
    userId: USER,
    requestedAction: "Pay $2,000 to Acme Home Care",
    toolName: "executePayment",
    requestingAgent: "finance",
    assignedAgent: "finance",
    permissionScope: "finance:payment",
    requiredRole: "caregiver",
    input: { amount: 2000, merchant: "Acme Home Care", orderId: "ord_1" },
  };
}

function freshService() {
  return new WorkItemService(new SandboxWorkItemStore());
}

async function proposed() {
  const svc = freshService();
  const item = await svc.propose(baseProposal());
  return { svc, item };
}

const attempt = (input: unknown, over: Partial<{ agentId: any; toolName: string; nowMs: number }> = {}) => ({
  agentId: over.agentId ?? ("finance" as const),
  toolName: over.toolName ?? "executePayment",
  input,
  nowMs: over.nowMs,
});

describe("controlled agent actions — execution gate (Track 3 enforcement)", () => {
  it("HAPPY PATH: a correctly approved work item executes exactly once", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewer: "Sarah", reviewerRole: "caregiver" });
    let ran = 0;
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => {
      ran++;
      return "Payment sent";
    });
    expect(res.ok).toBe(true);
    expect(ran).toBe(1);
    expect(res.item?.status).toBe("executed");
    expect(res.item?.result).toBe("Payment sent");
  });

  it("execution WITHOUT approval fails", async () => {
    const { svc, item } = await proposed();
    let ran = 0;
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => { ran++; return "x"; });
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("not_approved");
    expect(ran).toBe(0);
  });

  it("a TAMPERED input fails", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewer: "Sarah", reviewerRole: "caregiver" });
    const tampered = { amount: 9999, merchant: "Acme Home Care", orderId: "ord_1" };
    const res = await svc.execute(item.id, attempt(tampered), async () => "should not run");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("input_tampered");
  });

  it("an EXPIRED approval fails", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewer: "Sarah", reviewerRole: "caregiver", ttlMs: 1000 });
    const future = Date.now() + 60_000;
    const res = await svc.execute(item.id, attempt(baseProposal().input, { nowMs: future }), async () => "nope");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("expired");
    expect((await svc.get(item.id))?.status).toBe("expired");
  });

  it("the WRONG reviewer role fails", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewer: "Nosy Neighbor", reviewerRole: "neighbor" });
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => "nope");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("wrong_reviewer_role");
  });

  it("a REPLAYED approval fails (single-use)", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewer: "Sarah", reviewerRole: "caregiver" });
    const first = await svc.execute(item.id, attempt(baseProposal().input), async () => "paid once");
    expect(first.ok).toBe(true);
    const second = await svc.execute(item.id, attempt(baseProposal().input), async () => "paid twice");
    expect(second.ok).toBe(false);
    // status moved to executed after the first run; the gate refuses the replay.
    expect(["already_consumed", "not_approved"]).toContain(second.gate.code);
  });

  it("the WRONG agent cannot execute another agent's approved item", async () => {
    const svc = freshService();
    const item = await svc.propose({ ...baseProposal(), assignedAgent: "finance" });
    await svc.approve(item.id, { reviewer: "Sarah", reviewerRole: "caregiver" });
    const res = await svc.execute(item.id, attempt(baseProposal().input, { agentId: "care" }), async () => "nope");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("wrong_agent");
  });

  it("an approved STATUS alone (e.g. from Jira) is not enough without a valid reviewer", async () => {
    const store = new SandboxWorkItemStore();
    const svc = new WorkItemService(store);
    const item = await svc.propose(baseProposal());
    // Simulate an external tracker flipping the status to approved, with no local
    // reviewer/role/expiry recorded — exactly what the gate must not trust.
    await store.patch(item.id, { status: "approved" });
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => "nope");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("no_reviewer");
  });

  it("hashInput is order-independent and tamper-sensitive", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });
});
