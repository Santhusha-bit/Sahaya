import { describe, expect, it } from "vitest";
import {
  SandboxWorkItemStore,
  WorkItemService,
  hashInput,
  verifyHistory,
  type CreateWorkItemInput,
} from "@/agents/base/workItems";
import { ReviewerDirectory, authorizeDelegation, demoFamily } from "@/agents/base/workItemPolicy";
import { AgentService } from "@/agents/service";
import { getHouseholdCoordinator } from "@/integrations/jira";

const USER = "user-wi";

/** $400: standard tier, one caregiver approval. */
function baseProposal(over: Partial<CreateWorkItemInput> = {}): CreateWorkItemInput {
  return {
    userId: USER,
    requestedAction: "Pay $400 to Acme Home Care",
    toolName: "executePayment",
    requestingAgent: "guardian",
    assignedAgent: "finance",
    permissionScope: "finance:payment",
    input: { amount: 400, payee: "Acme Home Care", invoiceId: "inv_1" },
    ...over,
  };
}

function freshService() {
  const store = new SandboxWorkItemStore();
  return { store, svc: new WorkItemService(store, new ReviewerDirectory(demoFamily(USER))) };
}

async function proposed(over: Partial<CreateWorkItemInput> = {}) {
  const { store, svc } = freshService();
  const item = await svc.propose(baseProposal(over));
  return { store, svc, item };
}

const attempt = (input: unknown, over: Partial<{ agentId: any; toolName: string; nowMs: number }> = {}) => ({
  agentId: over.agentId ?? ("finance" as const),
  toolName: over.toolName ?? "executePayment",
  input,
  nowMs: over.nowMs,
});

describe("controlled agent actions: execution gate", () => {
  it("HAPPY PATH: a correctly approved work item executes exactly once", async () => {
    const { svc, item } = await proposed();
    expect((await svc.approve(item.id, { reviewerId: "sarah" })).ok).toBe(true);
    let ran = 0;
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => {
      ran++;
      return "Payment sent";
    });
    expect(res.ok).toBe(true);
    expect(ran).toBe(1);
    expect(res.item?.status).toBe("executed");
    expect(res.item?.result).toBe("Payment sent");
    expect(verifyHistory(res.item!.history)).toBe(-1);
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
    await svc.approve(item.id, { reviewerId: "sarah" });
    const res = await svc.execute(item.id, attempt({ ...baseProposal().input as object, amount: 9999 }), async () => "no");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("input_tampered");
  });

  it("an EXPIRED approval fails", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewerId: "sarah", ttlMs: 1000 });
    const res = await svc.execute(item.id, attempt(baseProposal().input, { nowMs: Date.now() + 60_000 }), async () => "no");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("expired");
    expect((await svc.get(item.id))?.status).toBe("expired");
  });

  it("a REPLAYED approval fails (single-use)", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewerId: "sarah" });
    expect((await svc.execute(item.id, attempt(baseProposal().input), async () => "paid once")).ok).toBe(true);
    const second = await svc.execute(item.id, attempt(baseProposal().input), async () => "paid twice");
    expect(second.ok).toBe(false);
    expect(["already_consumed", "not_approved"]).toContain(second.gate.code);
  });

  it("the WRONG agent cannot execute another agent's approved item", async () => {
    const { svc, item } = await proposed();
    await svc.approve(item.id, { reviewerId: "sarah" });
    const res = await svc.execute(item.id, attempt(baseProposal().input, { agentId: "guardian" }), async () => "no");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("wrong_agent");
  });

  it("an approved STATUS alone (e.g. flipped by Jira) is not enough", async () => {
    const { store, svc, item } = await proposed();
    await store.patch(item.id, { status: "approved" });
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => "no");
    expect(res.ok).toBe(false);
    expect(res.gate.code).toBe("no_reviewer");
  });

  it("hashInput is order-independent and tamper-sensitive", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });
});

describe("agent security: delegation policy", () => {
  it("Guardian may delegate a payment to Finance", () => {
    expect(authorizeDelegation(baseProposal()).ok).toBe(true);
  });

  it("Guardian cannot assign a payment to itself (no capability)", async () => {
    const { item } = await proposed({ assignedAgent: "guardian" });
    expect(item.status).toBe("rejected");
    expect(item.history.some((e) => e.action === "delegation_denied")).toBe(true);
  });

  it("Wellness cannot delegate money movement at all", () => {
    const d = authorizeDelegation({ ...baseProposal(), requestingAgent: "wellness" });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("delegation_denied");
  });

  it("a scope that does not match the tool is refused", () => {
    expect(authorizeDelegation({ ...baseProposal(), permissionScope: "finance:card" }).code).toBe("scope_mismatch");
  });

  it("a denied delegation can never be approved or executed", async () => {
    const { svc, item } = await proposed({ requestingAgent: "wellness" });
    expect((await svc.approve(item.id, { reviewerId: "sarah" })).code).toBe("not_reviewable");
    expect((await svc.execute(item.id, attempt(baseProposal().input), async () => "no")).ok).toBe(false);
  });
});

describe("agent security: reviewer authorization", () => {
  it("a reviewer's role comes from the directory, so a neighbor cannot approve", async () => {
    const { svc, item } = await proposed();
    const r = await svc.approve(item.id, { reviewerId: "neighbor" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("wrong_reviewer_role");
    expect(r.item?.history.at(-1)?.action).toBe("approval_denied");
  });

  it("an unregistered person cannot approve", async () => {
    const { svc, item } = await proposed();
    expect((await svc.approve(item.id, { reviewerId: "mallory" })).code).toBe("unknown_reviewer");
  });

  it("an agent cannot approve (separation of duties)", async () => {
    const { svc, item } = await proposed();
    expect((await svc.approve(item.id, { reviewerId: "guardian" })).code).toBe("reviewer_is_agent");
  });

  it("a reviewer from another household cannot approve", async () => {
    const store = new SandboxWorkItemStore();
    const svc = new WorkItemService(store, new ReviewerDirectory(demoFamily("other-household")));
    const item = await svc.propose(baseProposal());
    expect((await svc.approve(item.id, { reviewerId: "sarah" })).code).toBe("unknown_reviewer");
  });

  it("policy sets the required role; the requester cannot lower it", async () => {
    const { item } = await proposed();
    expect(item.requiredRole).toBe("caregiver");
  });
});

describe("agent security: dual control for high-value payments", () => {
  const big = { requestedAction: "Pay $2,000", input: { amount: 2000, payee: "Acme Home Care", invoiceId: "inv_2" } };

  it("$2,000 needs two DISTINCT caregivers", async () => {
    const { svc, item } = await proposed(big);
    expect(item.riskTier).toBe("high");
    expect(item.requiredApprovals).toBe(2);

    await svc.approve(item.id, { reviewerId: "sarah" });
    expect((await svc.get(item.id))?.status).toBe("in_review");
    const early = await svc.execute(item.id, attempt(big.input), async () => "no");
    expect(early.gate.code).toBe("not_approved");

    expect((await svc.approve(item.id, { reviewerId: "sarah" })).code).toBe("duplicate_approver");

    expect((await svc.approve(item.id, { reviewerId: "david" })).ok).toBe(true);
    expect((await svc.execute(item.id, attempt(big.input), async () => "paid")).ok).toBe(true);
  });

  it("a store-level status flip with one approval is caught as insufficient", async () => {
    const { store, svc, item } = await proposed(big);
    await svc.approve(item.id, { reviewerId: "sarah" });
    await store.patch(item.id, { status: "approved" });
    expect((await svc.execute(item.id, attempt(big.input), async () => "no")).gate.code).toBe("insufficient_approvals");
  });
});

describe("agent security: tamper-evident audit trail", () => {
  it("editing a history event breaks the chain and blocks execution", async () => {
    const { store, svc, item } = await proposed();
    await svc.approve(item.id, { reviewerId: "sarah" });
    const cur = (await svc.get(item.id))!;
    const forged = cur.history.map((e) => (e.action === "approved" ? { ...e, detail: "approved by someone else" } : e));
    await store.patch(item.id, { history: forged });
    const res = await svc.execute(item.id, attempt(baseProposal().input), async () => "no");
    expect(res.gate.code).toBe("audit_tampered");
  });

  it("an approval injected directly into the store (no audited event) is refused", async () => {
    const { store, svc, item } = await proposed();
    const now = Date.now();
    await store.patch(item.id, {
      status: "approved",
      approvals: [
        { id: "apv_fake", reviewerId: "sarah", reviewerName: "Sarah", reviewerRole: "caregiver", inputHash: item.inputHash, approvedAt: now, expiresAt: now + 60_000, source: "app" },
      ],
    });
    expect((await svc.execute(item.id, attempt(baseProposal().input), async () => "no")).gate.code).toBe("unbacked_approval");
  });

  it("changing the stored parameters after approval is caught", async () => {
    const { store, svc, item } = await proposed();
    await svc.approve(item.id, { reviewerId: "sarah" });
    const evil = { amount: 400, payee: "Scammer LLC", invoiceId: "inv_1" };
    await store.patch(item.id, { input: evil });
    expect((await svc.execute(item.id, attempt(evil), async () => "no")).gate.code).toBe("input_tampered");
  });
});

describe("Jira sync: external decisions must be attributable", () => {
  function jiraService() {
    const store = new SandboxWorkItemStore();
    const dir = new ReviewerDirectory(
      demoFamily(USER).map((p) => (p.id === "sarah" ? { ...p, jiraAccountId: "acct-sarah" } : p)),
    );
    return { svc: new WorkItemService(store, dir) };
  }

  it("a Jira transition by a bound caregiver approves through the normal checks", async () => {
    const { svc } = jiraService();
    const item = await svc.propose(baseProposal());
    const r = await svc.applyExternalDecision(item.id, { decision: "approve", externalAccountId: "acct-sarah", externalEventId: "h1", source: "jira" });
    expect(r.ok).toBe(true);
    expect(r.item?.approvals[0].source).toBe("jira");
    expect((await svc.execute(item.id, attempt(baseProposal().input), async () => "paid")).ok).toBe(true);
  });

  it("a Jira transition by an unknown account is recorded and ignored", async () => {
    const { svc } = jiraService();
    const item = await svc.propose(baseProposal());
    const r = await svc.applyExternalDecision(item.id, { decision: "approve", externalAccountId: "acct-intern", externalEventId: "h2", source: "jira" });
    expect(r.ok).toBe(false);
    expect(r.item?.status).toBe("in_review");
    expect(r.item?.history.at(-1)?.action).toBe("external_decision_ignored");
  });

  it("the same Jira event is applied only once", async () => {
    const { svc } = jiraService();
    const item = await svc.propose(baseProposal());
    const d = { decision: "approve" as const, externalAccountId: "acct-sarah", externalEventId: "h3", source: "jira" as const };
    await svc.applyExternalDecision(item.id, d);
    expect((await svc.applyExternalDecision(item.id, d)).skipped).toBe(true);
  });
});

describe("end to end: Guardian delegates, family approves, Finance executes", () => {
  it("runs through the real agents and tools", async () => {
    const user = "user-wi-e2e";
    const service = await AgentService.forUser(user);
    const input = { amount: 1800, payee: "Sunrise Home Care", invoiceId: "INV-1042" };

    const { record: proposal } = await service.runTool("guardian", "delegateToAgent", {
      assignedAgent: "finance",
      toolName: "executePayment",
      requestedAction: "Pay $1,800 Sunrise Home Care invoice INV-1042 (new payee, verified by phone)",
      input,
    });
    expect(proposal.status).toBe("success");
    const workItemId = (proposal.output as { workItemId: string }).workItemId;

    const tooEarly = await service.runTool("finance", "executeDelegatedWorkItem", { workItemId });
    expect(tooEarly.record.status).toBe("error");

    const { service: items } = getHouseholdCoordinator(user);
    await items.approve(workItemId, { reviewerId: "sarah" });
    await items.approve(workItemId, { reviewerId: "david" });

    const wrongAgent = await service.runTool("care", "executeDelegatedWorkItem", { workItemId });
    expect(wrongAgent.record.status).toBe("error");

    const done = await service.runTool("finance", "executeDelegatedWorkItem", { workItemId });
    expect(done.record.status).toBe("success");
    expect(done.record.summary).toContain("Paid $1800.00");

    const final = await items.get(workItemId);
    expect(final?.status).toBe("executed");
    expect(verifyHistory(final!.history)).toBe(-1);
    expect(final!.history.map((e) => e.action)).toEqual(
      expect.arrayContaining(["proposed", "submitted_for_review", "approved", "authorization_complete", "execution_denied", "executed"]),
    );
  });
});
