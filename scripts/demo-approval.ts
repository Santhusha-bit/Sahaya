/**
 * npm run demo:approval
 *
 * Agent security + coordination, end to end through the real agents:
 *   1. Guardian identifies a task that needs Finance (paying a $1,800 invoice
 *      to a new home-care payee) and delegates it as a work item.
 *   2. Policy authorizes the delegation, sets the risk tier (dual control) and
 *      mirrors the item to Jira when ATLASSIAN_* creds are present.
 *   3. Attacks the gate must stop: early execution, a neighbor approving,
 *      Guardian self-assigning, a forged audit event, edited parameters.
 *   4. Two caregivers approve; Finance executes exactly once; replay refused.
 *   5. The hash-chained audit trail is printed and verified.
 */

import { jiraStatus } from "@/lib/env";
import { getHouseholdCoordinator } from "@/integrations/jira";
import { AgentService } from "@/agents/service";
import { verifyHistory } from "@/agents/base/workItems";

const USER = "demo-margaret";
const line = (c = "─") => console.log(c.repeat(72));
const verdict = (ok: boolean, expectOk: boolean) => (ok === expectOk ? "✓" : "✗ UNEXPECTED");

async function main() {
  const coord = getHouseholdCoordinator(USER);
  const items = coord.service;
  const agents = await AgentService.forUser(USER);
  const checks: boolean[] = [];
  const check = (label: string, ok: boolean, expectOk: boolean, detail?: string) => {
    checks.push(ok === expectOk);
    console.log(`  ${verdict(ok, expectOk)} ${label}${detail ? `: ${detail}` : ""}`);
  };

  line("═");
  console.log(`SAHAYA: agent security & coordination (work-item backend: ${coord.backend})`);
  console.log(`Jira: ${jiraStatus().mode}. ${jiraStatus().detail}`);
  line("═");

  const input = { amount: 1800, payee: "Sunrise Home Care", invoiceId: "INV-1042" };

  console.log("\n1. Guardian delegates the payment to Finance");
  const { record: proposal } = await agents.runTool("guardian", "delegateToAgent", {
    assignedAgent: "finance",
    toolName: "executePayment",
    requestedAction: "Pay $1,800 Sunrise Home Care invoice INV-1042 (new payee, verified by callback)",
    input,
  });
  console.log(`  Guardian: ${proposal.summary}`);
  const workItemId = (proposal.output as { workItemId: string }).workItemId;
  const item = (await items.get(workItemId))!;
  console.log(`  Work item ${item.id}: tier=${item.riskTier}, needs ${item.requiredApprovals}x ${item.requiredRole}${item.externalKey ? `, Jira ${item.externalKey}` : ""}`);

  console.log("\n2. Attempts the gate must refuse");
  const selfAssign = await agents.runTool("guardian", "delegateToAgent", {
    assignedAgent: "care",
    toolName: "executePayment",
    requestedAction: "Care pays the invoice instead",
    input,
  });
  check("Guardian routes a payment to Care (no capability)", selfAssign.record.status === "success", false, selfAssign.record.summary);

  const early = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId });
  check("Finance executes before approval", early.record.status === "success", false, early.record.summary);

  const neighbor = await items.approve(workItemId, { reviewerId: "neighbor" });
  check("Neighbor approves", neighbor.ok, false, neighbor.reason);

  const agentApprove = await items.approve(workItemId, { reviewerId: "guardian" });
  check("Guardian approves its own request", agentApprove.ok, false, agentApprove.reason);

  console.log("\n3. Family review (dual control)");
  const sarah = await items.approve(workItemId, { reviewerId: "sarah" });
  check("Sarah (caregiver) approves", sarah.ok, true, `status ${sarah.item?.status}`);
  const half = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId });
  check("Finance executes with 1 of 2 approvals", half.record.status === "success", false, half.record.summary);
  const sarahAgain = await items.approve(workItemId, { reviewerId: "sarah" });
  check("Sarah approves a second time", sarahAgain.ok, false, sarahAgain.reason);
  const david = await items.approve(workItemId, { reviewerId: "david" });
  check("David (caregiver) approves", david.ok, true, `status ${david.item?.status}`);

  if (coord.syncFromJira) {
    const sync = await coord.syncFromJira(workItemId);
    console.log(`  Jira sync: ${sync.applied} applied, ${sync.ignored} ignored${sync.error ? ` (${sync.error})` : ""}`);
  }

  console.log("\n4. Execution");
  const done = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId });
  check("Finance executes the approved payment", done.record.status === "success", true, done.record.summary);
  const replay = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId });
  check("Replay the same approval", replay.record.status === "success", false, replay.record.summary);

  console.log("\n5. A second item: tampering after approval");
  const { record: p2 } = await agents.runTool("guardian", "delegateToAgent", {
    assignedAgent: "finance",
    toolName: "freezeCard",
    requestedAction: "Freeze card ending 4417 after suspicious charge",
    input: { last4: "4417", reason: "suspicious charge" },
  });
  const id2 = (p2.output as { workItemId: string }).workItemId;
  await items.approve(id2, { reviewerId: "sarah" });
  const stored = (await items.get(id2))!;
  // Simulate someone editing the audit log in the database to hide who approved.
  const forged = stored.history.map((e) => (e.action === "approved" ? { ...e, actor: "david" } : e));
  await (items as unknown as { store: { patch: (id: string, p: object) => Promise<unknown> } }).store.patch(id2, { history: forged });
  const t = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId: id2 });
  check("Execute after audit log was edited", t.record.status === "success", false, t.record.summary);

  line();
  const final = (await items.get(workItemId))!;
  console.log(`Audit trail for ${final.id} (${final.status}, chain ${verifyHistory(final.history) === -1 ? "intact" : "BROKEN"}):`);
  for (const e of final.history) {
    console.log(`  ${e.hash?.slice(0, 8)}  [${e.actor}] ${e.action}${e.detail ? `: ${e.detail}` : ""}`);
  }

  line("═");
  const pass = checks.every(Boolean) && final.status === "executed";
  console.log(pass ? `✓ All ${checks.length} checks behaved as enforced by code.` : "✗ Enforcement FAILED.");
  line("═");
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
