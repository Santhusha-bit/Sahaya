/**
 * npm run demo:investigation
 *
 * Factory Droid SDK track: Finance delegates a medical-bill investigation to a
 * separate Droid execution agent, prints every step as it happens, verifies the
 * Droid's numbers itself, and drafts a dispute that stays approval-gated.
 *
 * With FACTORY_API_KEY set (shell or .env.local) this is a real Droid run.
 * Without it, Finance's local engine runs instead and says so.
 */

import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getInvestigation, runInvestigation, startInvestigation } from "@/agents/finance/investigation/service";
import { factoryDroidStatus } from "@/lib/env";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // No .env.local: environment variables only.
  }
  const USER = "demo-margaret";
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  const finance = createAgent("finance", { data, userId: USER });
  await finance.initialize();

  const status = factoryDroidStatus();
  line("═");
  console.log("Finance: \"Investigate this bill\"");
  console.log(`Factory Droid SDK: ${status.mode.toUpperCase()}. ${status.detail}`);
  line("═");

  const inv = await startInvestigation({ memory: finance.memory, tasks: finance.taskService });
  console.log(`Queued ${inv.id} (task ${inv.taskId}, engine ${inv.engine})`);

  // Print steps live while the worker runs.
  let printed = 0;
  const startedAt = Date.now();
  const poll = setInterval(async () => {
    const cur = await getInvestigation(finance.memory, inv.id);
    for (const s of cur?.steps.slice(printed) ?? []) {
      console.log(`  +${((s.at - startedAt) / 1000).toFixed(1).padStart(5)}s  [${s.kind}] ${s.label}${s.detail ? `\n           ${s.detail.slice(0, 200)}` : ""}`);
    }
    printed = cur?.steps.length ?? printed;
  }, 250);

  const done = await runInvestigation(finance, inv.id);
  await new Promise((r) => setTimeout(r, 400));
  clearInterval(poll);
  line();

  if (!done || done.status !== "completed" || !done.report) {
    console.log(`Investigation ${done?.status ?? "missing"}: ${done?.errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Droid session: ${done.droidSessionId ?? "(local engine)"}  duration ${((done.durationMs ?? 0) / 1000).toFixed(1)}s`);
  console.log(`Verified by Finance: ${done.verification?.verified ? "yes" : "NO"}`);
  for (const f of done.report.findings) console.log(`  - ${f.title}: $${f.amount.toFixed(2)} [${f.lineIds.join(", ")}]`);
  line();
  console.log(`Finance to Margaret: ${done.financeSummary}`);

  if (done.approvalId) {
    const pending = await data.approvals.get(done.approvalId);
    console.log(`\nApproval pending: ${pending?.title}`);
    console.log(`Submitted before approval? ${(await finance.memory.list("financialActions")).length ? "YES (bug)" : "no"}`);
    const { record } = await service.decideApproval("finance", done.approvalId, "approve");
    console.log(`Margaret approves -> ${record?.summary}`);
  }
  line("═");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
