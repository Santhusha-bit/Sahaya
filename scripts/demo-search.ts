/**
 * npm run demo:search
 *
 * "Has someone tried this scam before?" Guardian searches the person's own past
 * incidents (PII-redacted) and surfaces the most relevant one with its id, date,
 * and an evidence snippet. Sandbox in-memory index unless Elasticsearch is set.
 */

import { elasticStatus } from "@/lib/env";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import {
  MARGARET_SCAM_MESSAGE,
  MARGARET_USER,
  indexSeededIncidents,
  seedMargaretScenario,
} from "@/agents/guardian/scamScenario";

function line(c = "─") {
  console.log(c.repeat(68));
}

async function main() {
  const data = createInMemoryDataLayer();
  await seedMargaretScenario(data, MARGARET_USER);
  const indexed = await indexSeededIncidents(data, MARGARET_USER);

  const guardian = createAgent("guardian", { data, userId: MARGARET_USER });
  await guardian.initialize();

  // Today's inbound also gets indexed as it is screened.
  await guardian.executeTool("screenInboundMessage", {
    content: MARGARET_SCAM_MESSAGE, channel: "phone", claimant: "Jake",
  });

  line("═");
  console.log(`KINLINE — Incident search demo (index: ${elasticStatus().mode})`);
  console.log(`${elasticStatus().detail}`);
  console.log(`Indexed ${indexed} past incidents + today's screening.`);
  line("═");

  const queries = [
    "someone is impersonating my grandson asking for gift cards",
    "the IRS says I will be arrested over back taxes",
    "Amazon security called about gift cards",
  ];

  let allTop = true;
  for (const q of queries) {
    const { result } = await guardian.executeTool("searchPastIncidents", { query: q });
    const data0 = result.data as { hits: any[] };
    console.log(`\nQ: "${q}"`);
    console.log(result.summary.split("\n")[0]);
    for (const h of data0.hits.slice(0, 3)) {
      console.log(`   - [${h.incidentId}] ${h.scamType} (${h.riskLevel}) — ${h.snippet}`);
    }
    if (!data0.hits.length) allTop = false;
  }

  line("═");
  console.log(allTop ? "✓ Each query returned a cited, ranked incident match." : "✗ A query returned no match.");
  line("═");
  if (!allTop) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
