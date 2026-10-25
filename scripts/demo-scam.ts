/**
 * npm run demo:scam
 *
 * The shared demo scenario end to end: Margaret receives the fake-grandson gift
 * card message. Guardian detects, applies the deterministic policy, verifies with
 * the real Jake through a trusted number, records an incident, and alerts her
 * daughter (a caregiver with incidents:view). All fictional data.
 */

import { AuditLog } from "@/agents/base/audit";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { MARGARET_SCAM_MESSAGE, MARGARET_USER, seedMargaretScenario } from "@/agents/guardian/scamScenario";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  const data = createInMemoryDataLayer();
  await seedMargaretScenario(data, MARGARET_USER);

  const guardian = createAgent("guardian", { data, userId: MARGARET_USER });
  await guardian.initialize();

  line("═");
  console.log("Sahaya — Guardian scam workflow demo (sandbox, fictional data)");
  line("═");
  console.log(`\nMargaret receives on her phone:\n  "${MARGARET_SCAM_MESSAGE}"\n`);

  const { record, result } = await guardian.executeTool("screenInboundMessage", {
    content: MARGARET_SCAM_MESSAGE,
    channel: "phone",
    claimant: "Jake",
  });

  const d = result.data as Record<string, any>;

  line();
  console.log("Guardian says to Margaret:\n");
  console.log(`  ${result.summary}\n`);

  line();
  console.log(`Risk level:   ${String(d.risk).toUpperCase()}`);
  console.log(`Outcome:      ${d.outcome}`);
  console.log(`Transfer:     ${d.blocked ? "BLOCKED" : "not blocked"}`);
  console.log("\nPolicy decisions (deterministic):");
  for (const reason of d.blockedActions as string[]) console.log(`  • ${reason}`);

  if (d.verification) {
    const v = d.verification;
    console.log("\nIndependent verification (trusted directory only):");
    console.log(`  Contacted ${v.contact} (${v.relationship ?? "trusted contact"}) via ${v.channel}, method=${v.method}`);
    console.log(`  Result: ${v.result === "denied" ? "the real Jake did NOT send this — impersonation confirmed" : v.result}`);
  }

  console.log("\nCaregivers alerted (hold incidents:view):");
  const alerted = d.caregiversAlerted as string[];
  console.log(alerted.length ? `  • ${alerted.join(", ")}` : "  (none)");
  console.log(`\nIncident stored: ${d.incidentId}`);
  console.log(`Tool call status: ${record.status}`);

  line();
  console.log("Audit log for this workflow:");
  const audit = new AuditLog(data.memory, MARGARET_USER);
  const entries = await audit.list();
  for (const e of entries) {
    console.log(`  [${e.actor}] ${e.action}`);
  }

  line("═");
  const ok =
    d.blocked === true &&
    d.outcome === "scam_confirmed" &&
    alerted.length >= 1 &&
    d.verification?.result === "denied";
  console.log(ok ? "✓ Acceptance met: warning, blocked transfer, verification, incident, caregiver alert." : "✗ Acceptance NOT met.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
