/**
 * npm run demo:search
 *
 * "Has someone tried this scam before?" End to end:
 *   1. Guardian's past incidents are saved in the data layer (Convex when live).
 *   2. The indexing job writes allowlisted, PII-redacted incident text + metadata
 *      into the search index (Elasticsearch when live).
 *   3. A new scam call arrives; Guardian screens it (saved + indexed).
 *   4. The person asks "Has someone tried this scam before?"; Guardian searches
 *      their history, excluding today's incident.
 *   5. Claude (when live) summarizes the matches with dates and evidence; code
 *      checks the citations and appends the "not necessarily the same caller" note.
 *
 * Each run uses a fresh demo user id, so live runs never mix with real data, and
 * its Convex rows and index documents are removed at the end (KEEP_DEMO_DATA=1 keeps them).
 */

import "./loadEnv";
import { elasticStatus, isClaudeLive } from "@/lib/env";
import { getDataLayer } from "@/agents/base/dataLayer";
import { createAgent } from "@/agents/registry";
import { MARGARET_SCAM_MESSAGE, seedMargaretScenario } from "@/agents/guardian/scamScenario";
import { runIncidentIndexJob } from "@/agents/guardian/incidentIndexer";
import { NOT_SAME_CALLER } from "@/agents/guardian/incidentSummary";
import { getIncidentIndex } from "@/integrations/search";

/** True if `text` names the ISO date (YYYY-MM-DD) either as-is or spelled out ("October 4, 2026"). */
function mentionsDate(text: string, iso: string): boolean {
  if (text.includes(iso)) return true;
  const d = new Date(`${iso}T12:00:00Z`);
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return new RegExp(`${month}\\s+${d.getUTCDate()}(st|nd|rd|th)?,?\\s+${d.getUTCFullYear()}`).test(text);
}

function line(c = "─") {
  console.log(c.repeat(72));
}

async function main() {
  const userId = `demo-search-${Date.now()}`;
  const data = getDataLayer();

  line("═");
  console.log("SAHAYA Guardian: incident search demo");
  console.log(`Data layer: ${data.backend}   Search index: ${elasticStatus().mode}   Claude: ${isClaudeLive() ? "live" : "template"}`);
  console.log(elasticStatus().detail);
  line("═");

  // 1 + 2. Past incidents saved, then the indexing job backfills the index.
  await seedMargaretScenario(data, userId);
  const job = await runIncidentIndexJob(data, userId);
  console.log(`\n[1] ${job.results.length} past scam attempts saved in ${data.backend}.`);
  console.log(`[2] Index job: ${job.indexed} indexed, ${job.skipped} skipped, ${job.failed} failed.`);
  for (const r of job.results.filter((x) => x.status === "failed")) console.log(`    ! ${r.incidentId}: ${r.error}`);

  // 3. Today's call is screened, saved, and indexed by the live workflow.
  const guardian = createAgent("guardian", { data, userId });
  await guardian.initialize();
  const screened = await guardian.executeTool("screenInboundMessage", {
    content: MARGARET_SCAM_MESSAGE, channel: "phone", claimant: "Jake",
  });
  const todayId = (screened.result.data as { incidentId: string }).incidentId;
  console.log(`\n[3] New call: "${MARGARET_SCAM_MESSAGE}"`);
  console.log(`    Screened and saved as ${todayId}.`);

  // 4 + 5. "Has someone tried this scam before?"
  console.log(`\n[4] Margaret asks: "Has someone tried this scam before?"`);
  const { result } = await guardian.executeTool("searchPastIncidents", {
    query: MARGARET_SCAM_MESSAGE,
    excludeIncidentId: todayId,
  });
  const d = result.data as {
    summarizedBy: string;
    hits: { incidentId: string; date: string; scamType: string; channel: string; score: number; snippet: string; sharedTactics: string[] }[];
  };
  console.log("\n    Ranked matches:");
  for (const [i, h] of d.hits.entries()) {
    console.log(`    ${i + 1}. ${h.date} [${h.incidentId}] ${h.scamType} via ${h.channel} (score ${h.score.toFixed(2)})`);
    console.log(`       evidence: "${h.snippet}"`);
    if (h.sharedTactics.length) console.log(`       shared tactics: ${h.sharedTactics.join("; ")}`);
  }
  console.log(`\n[5] Guardian (${d.summarizedBy}):\n`);
  console.log(`    ${result.summary}`);

  // Checks: the most relevant incident is the earlier grandchild + gift card call,
  // the answer cites it with its date, and it carries the not-same-caller caveat.
  const top = d.hits[0];
  const checks: [string, boolean][] = [
    ["a match was found", !!top],
    ["today's incident did not match itself", !d.hits.some((h) => h.incidentId === todayId)],
    ["top match is the earlier fake-grandchild gift-card call", !!top && top.scamType === "fake_grandchild" && /gift card/i.test(top.snippet)],
    ["answer cites the top incident id", !!top && result.summary.includes(top.incidentId)],
    ["answer includes the top incident date", !!top && mentionsDate(result.summary, top.date)],
    ["answer does not claim the same caller", result.summary.includes(NOT_SAME_CALLER)],
  ];

  if (process.env.KEEP_DEMO_DATA !== "1") await getIncidentIndex().removeUser(userId);
  if (data.backend === "convex" && process.env.KEEP_DEMO_DATA !== "1") {
    const rows = [
      ...(await data.memory.list({ namespace: "guardian", userId })),
      ...(await data.memory.list({ namespace: "shared", userId })),
    ];
    for (const r of rows) await data.memory.remove(r.id);
    console.log(`\n(Removed ${rows.length} demo rows from Convex.)`);
  }

  line("═");
  for (const [label, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${label}`);
  line("═");
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
