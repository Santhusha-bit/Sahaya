/**
 * npm run demo:approval
 *
 * Controlled agent actions: Finance proposes a $2,000 payment, it becomes a
 * reviewable work item, a caregiver approves it, and only then does it execute
 * through the code gate. Also shows the gate refusing a tampered replay. The
 * history view prints the full audit trail. Sandbox store unless Jira creds exist.
 */

import { jiraStatus } from "@/lib/env";
import { createWorkItemStore } from "@/integrations/jira";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  const { service, backend } = createWorkItemStore();
  const USER = "demo-margaret";

  line("═");
  console.log(`KINLINE — Controlled agent actions demo (work-item store: ${backend})`);
  console.log(`Jira integration: ${jiraStatus().mode} — ${jiraStatus().detail}`);
  line("═");

  const input = { amount: 2000, merchant: "Acme Home Care", orderId: "ord_2026_1021" };
  const item = await service.propose({
    userId: USER,
    requestedAction: "Pay $2,000 to Acme Home Care (monthly care invoice)",
    toolName: "executePayment",
    requestingAgent: "finance",
    assignedAgent: "finance",
    permissionScope: "finance:payment",
    requiredRole: "caregiver",
    input,
  });
  console.log(`\nFinance proposed work item ${item.id} — status: ${item.status}`);

  // 1. Try to execute before approval — must be refused.
  const early = await service.execute(item.id, { agentId: "finance", toolName: "executePayment", input }, async () => "PAID");
  console.log(`\nExecute before approval: ${early.ok ? "RAN (bug!)" : "refused"} — ${early.gate.reason}`);

  // 2. Wrong reviewer role tries to approve — the gate still refuses execution.
  await service.approve(item.id, { reviewer: "Nosy Neighbor", reviewerRole: "neighbor" });
  const badRole = await service.execute(item.id, { agentId: "finance", toolName: "executePayment", input }, async () => "PAID");
  console.log(`Execute with neighbor approval: ${badRole.ok ? "RAN (bug!)" : "refused"} — ${badRole.gate.reason}`);

  // 3. Caregiver approves with the required role.
  await service.approve(item.id, { reviewer: "Sarah (daughter)", reviewerRole: "caregiver", ttlMs: 15 * 60_000 });
  console.log(`\nCaregiver 'Sarah' approved the work item.`);

  // 4. Tampered amount is rejected by the input-hash check.
  const tampered = await service.execute(
    item.id,
    { agentId: "finance", toolName: "executePayment", input: { ...input, amount: 5000 } },
    async () => "PAID",
  );
  console.log(`Execute with tampered amount ($5,000): ${tampered.ok ? "RAN (bug!)" : "refused"} — ${tampered.gate.reason}`);

  // 5. The genuine, approved execution runs — once.
  const ok = await service.execute(
    item.id,
    { agentId: "finance", toolName: "executePayment", input },
    async (wi) => `Paid $${(wi.input as any).amount} to ${(wi.input as any).merchant}`,
  );
  console.log(`\nApproved execution: ${ok.ok ? "SUCCESS" : "refused"} — ${ok.result ?? ok.gate.reason}`);

  // 6. Replay is refused (single-use).
  const replay = await service.execute(item.id, { agentId: "finance", toolName: "executePayment", input }, async () => "PAID AGAIN");
  console.log(`Replay the same approval: ${replay.ok ? "RAN (bug!)" : "refused"} — ${replay.gate.reason}`);

  line();
  console.log("Work item history:");
  const finalItem = await service.get(item.id);
  for (const e of finalItem?.history ?? []) {
    console.log(`  [${e.actor}] ${e.action}${e.detail ? `: ${e.detail}` : ""}`);
  }

  line("═");
  const pass =
    !early.ok && !badRole.ok && !tampered.ok && ok.ok && !replay.ok && finalItem?.status === "executed";
  console.log(pass ? "✓ Gate enforced: only the valid, approved, untampered, single-use execution ran." : "✗ Gate FAILED.");
  line("═");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
