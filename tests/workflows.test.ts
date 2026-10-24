import { describe, expect, it } from "vitest";
import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";

const USER = "user-flow";

describe("sensitive actions require approval (prompt §2, §9)", () => {
  it("a tool marked requiresApproval defers until approved, then executes", async () => {
    const data = createInMemoryDataLayer();
    const care = createAgent("care", { data, userId: USER });
    await care.initialize();

    // Build a cart first.
    const cart = await care.executeTool("createShoppingCart", {
      items: [{ productId: "p_milk", quantity: 1 }, { productId: "p_eggs", quantity: 2 }],
    });
    expect(cart.result.ok).toBe(true);
    const cartId = (cart.result.data as any).cartId as string;

    // Requesting the order should DEFER (no purchase yet).
    const deferred = await care.executeTool("requestOrderApproval", { cartId });
    expect(deferred.record.status).toBe("awaiting_approval");
    expect(deferred.record.approvalId).toBeTruthy();

    // No order placed yet.
    expect(await care.memory.list("orders")).toHaveLength(0);

    // Now execute as approved.
    const approved = await care.executeTool("requestOrderApproval", { cartId }, { approved: true });
    expect(approved.result.ok).toBe(true);
    expect(await care.memory.list("orders")).toHaveLength(1);
  });

  it("invalid tool input is rejected with an error, not executed", async () => {
    const data = createInMemoryDataLayer();
    const finance = createAgent("finance", { data, userId: USER });
    const bad = await finance.executeTool("analyzeMedicalBill", { provider: "X" }); // missing lineItems
    expect(bad.result.ok).toBe(false);
    expect(bad.record.status).toBe("error");
  });
});

describe("end-to-end cross-agent workflow: Care order -> Finance review", () => {
  it("approving a Care grocery order publishes a payment.review that Finance handles", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();

    // Care prepares the order (sandbox planner creates a pending approval).
    await service.sendMessage("care", "I need my usual groceries delivered tomorrow");
    const careState = await service.agentState("care");
    expect(careState.approvals.length).toBeGreaterThanOrEqual(1);

    const approval = careState.approvals[0];
    const decision = await service.decideApproval("care", approval.id, "approve");
    expect(decision.approval?.status).toBe("approved");

    // Finance should have received and handled the payment.review event.
    const financeState = await service.agentState("finance");
    const reviewTask = financeState.tasks.find((t) => t.title.startsWith("Payment review"));
    expect(reviewTask).toBeTruthy();

    // The authorized event is on the bus with a narrow payload only.
    const events = await service.allEvents();
    const paymentEvent = events.find((e) => e.type === "payment.review");
    expect(paymentEvent).toBeTruthy();
    expect(paymentEvent!.sourceAgent).toBe("care");
    expect(paymentEvent!.targetAgent).toBe("finance");
    expect(paymentEvent!.payload).toHaveProperty("amount");
    expect(paymentEvent!.payload).not.toHaveProperty("lines");
  });

  it("Wellness escalates a safety concern and Guardian records an incident", async () => {
    const data = createInMemoryDataLayer();
    const service = new AgentService(data, USER);
    await service.initializeAll();

    await service.sendMessage("wellness", "Someone keeps coming to my door and I feel unsafe and scared");

    const events = await service.allEvents();
    const escalation = events.find((e) => e.type === "safety.escalation");
    expect(escalation).toBeTruthy();

    const guardianState = await service.agentState("guardian");
    const incidentTask = guardianState.tasks.find((t) => t.title.toLowerCase().includes("safety escalation"));
    expect(incidentTask).toBeTruthy();

    const incidents = await createAgent("guardian", { data, userId: USER }).memory.list("incidents");
    expect(incidents.some((i) => String(i.data.summary).startsWith("From Wellness"))).toBe(true);
  });
});
