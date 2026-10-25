/**
 * npm run demo:backboard
 *
 * Shows Backboard historical-context retrieval: after a few past conversations are
 * stored, a new message about sleep retrieves the earlier sleep conversation so
 * Wellness can respond with real continuity. Live with BACKBOARD_API_KEY, else a
 * labeled sandbox with the same interface.
 */

import { backboardStatus } from "@/lib/env";
import { getHistoricalContextProvider, resetHistoricalContextProvider } from "@/integrations/backboard";

function line(c = "─") { console.log(c.repeat(70)); }

async function main() {
  resetHistoricalContextProvider();
  const bb = getHistoricalContextProvider();
  const status = backboardStatus();

  line("═");
  console.log(`Sahaya — Backboard historical context (mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  const userId = "margaret";
  await bb.store({ userId, topic: "sleep", summary: "Mentioned trouble sleeping; about five hours last Tuesday." });
  await bb.store({ userId, topic: "social", summary: "Lovely visit from her neighbor over the weekend." });
  await bb.store({ userId, topic: "sleep", summary: "Woke several times; worried about an upcoming appointment." });
  // Another user's memory — must never surface for margaret.
  await bb.store({ userId: "someone-else", topic: "sleep", summary: "Different person's private note." });

  const query = "I haven't been sleeping well and only slept four hours last night.";
  const hits = await bb.retrieve({ userId, query, limit: 3 });

  console.log(`\nQ: "${query}"`);
  for (const h of hits) console.log(`   - (${h.score.toFixed(2)}) [${h.context.topic}] ${h.context.summary}`);

  const leaked = hits.some((h) => h.context.userId !== userId);
  const foundSleep = hits.some((h) => h.context.topic === "sleep");

  line("═");
  const ok = foundSleep && !leaked;
  console.log(ok ? "✓ Retrieved relevant sleep history; no cross-user leakage." : "✗ Retrieval failed or leaked another user's memory.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
