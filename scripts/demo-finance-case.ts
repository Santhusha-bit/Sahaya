/**
 * npm run demo:finance-case
 *
 * Hyphenate (autonomous systems for finance): Margaret uploads a hospital
 * statement and her insurance EOB. Finance extracts both, reconciles them with
 * deterministic rules, finds the duplicate charge, builds an evidence-backed
 * case and a dispute draft, waits for her approval of that exact letter,
 * submits it (sandbox billing office), tracks the response, and verifies the
 * corrected balance. Every step lands in a hash-chained audit trail.
 */

import { claudeStatus, disputeChannelStatus } from "@/lib/env";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { verifyChain } from "@/agents/finance/investigation/auditChain";
import { FINANCE_AGENT, caseSnapshot, CaseActionDenied, reviewFinding, trackCase } from "@/agents/finance/investigation/caseService";
import { getDisputeChannel } from "@/integrations/billingOffice";

const line = (c = "─") => console.log(c.repeat(72));
const usd = (n: number) => `$${n.toFixed(2)}`;

async function main() {
  process.env.FINANCE_CASE_STEP_MS ??= "300";
  const USER = "demo-margaret";
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  const finance = createAgent("finance", { data, userId: USER });
  await finance.initialize();
  const read = () => caseSnapshot({ memory: finance.memory, approvals: finance.approvalService });

  line("═");
  console.log("SAHAYA Finance: autonomous bill investigation (Hyphenate track)");
  console.log(`Analyst:        ${claudeStatus().mode}. ${claudeStatus().detail}`);
  console.log(`Billing office: ${disputeChannelStatus().mode}. ${disputeChannelStatus().detail}`);
  line("═");

  console.log(`\n1. Margaret: "Can you check my hospital bill against my insurance EOB?"`);
  const { reply } = await service.sendMessage("finance", "Can you check my hospital bill against my insurance EOB?");
  console.log(`   Finance: ${reply.text.split("\n\n").slice(-1)[0].replace(/^• /, "")}`);

  let snap = await read();
  const c = snap.case!;
  console.log(`\n2. Extracted (${c.bill.extractedBy}/${c.eob.extractedBy}): ${c.bill.lines.length} statement lines, ${c.eob.lines.length} EOB lines`);
  for (const d of c.documents) console.log(`   ${d.kind.padEnd(4)} ${d.fileName}  sha256 ${d.sha256.slice(0, 16)}…`);

  console.log(`\n3. Findings (statement ${usd(c.reconciliation.billAmountDue)} vs EOB ${usd(c.reconciliation.insurerSaysYouOwe)}):`);
  for (const f of c.reconciliation.findings) {
    console.log(`   ${f.findingId} [${f.severity}] ${f.title}  (${usd(f.amountAtIssue)})${f.explainedBy ? `  explained by ${f.explainedBy}` : ""}`);
    for (const e of f.evidence) console.log(`        ${e.doc === "bill" ? "statement" : "EOB      "} ${e.lineId}: ${e.quote}`);
    for (const k of f.calculations) console.log(`        = ${k.label}: ${k.expression} -> ${k.result}`);
  }
  console.log(`   Checks passed: ${c.reconciliation.checks.filter((x) => x.passed).length}/${c.reconciliation.checks.length}`);

  console.log(`\n4. Least privilege: Finance tries to mark its own finding as reviewed...`);
  try {
    await reviewFinding(finance.buildContext("corr_demo", () => {}), { caseId: c.caseId, findingId: "F1", decision: "dismiss" }, FINANCE_AGENT);
  } catch (err) {
    if (err instanceof CaseActionDenied) console.log(`   DENIED: ${err.message} (recorded in the audit trail)`);
    else throw err;
  }

  snap = await read();
  console.log(`\n5. Draft v${snap.case!.draft!.version} (${snap.case!.draft!.kind}) to ${snap.case!.draft!.recipient.email}, fingerprint ${snap.case!.draft!.draftHash}`);
  line();
  console.log(`Subject: ${snap.case!.draft!.subject}\n`);
  console.log(snap.case!.draft!.body);
  line();
  console.log(`   Pending approval: ${snap.approval!.title}`);

  console.log(`\n6. Margaret reviews the evidence and approves this exact letter.`);
  const decided = await service.decideApproval("finance", snap.approval!.id, "approve");
  console.log(`   ${decided.record?.summary}`);

  console.log(`\n7. Tracking the case:`);
  const ctx = finance.buildContext("corr_demo_track", () => {});
  const step = Number(process.env.FINANCE_CASE_STEP_MS);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, step + 20));
    const t = await trackCase(ctx, getDisputeChannel());
    const last = t!.updates[t!.updates.length - 1];
    console.log(`   ${t!.status.padEnd(18)} ${last.message ?? last.label}`);
    if (t!.resolution) {
      console.log(`   Verification: ${t!.resolution.matches ? "PASS" : "FOLLOW-UP"}: ${t!.resolution.detail}`);
      break;
    }
  }

  snap = await read();
  const v = verifyChain(snap.case!.chain);
  console.log(`\n8. Audit trail: ${snap.case!.chain.length} hash-chained entries, verification ${v.ok ? "PASSED" : `FAILED at ${v.brokenAt}`}`);
  for (const e of snap.case!.chain) console.log(`   ${String(e.seq).padStart(2)} ${e.action.padEnd(24)} ${e.actor.padEnd(28)} ${e.hash.slice(0, 12)}`);
  line("═");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
