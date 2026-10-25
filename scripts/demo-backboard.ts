/**
 * npm run demo:backboard
 *
 * Backboard long-term conversational context, end to end:
 *   Day 0  Margaret mentions her garden and her daughter's upcoming visit.
 *          Permitted facts go to Convex (canonical) and are indexed in Backboard.
 *          A health remark in the same message is NOT indexed.
 *   Day 5  "Do you remember what I told you about my garden?" -> Backboard search,
 *          every hit re-verified against Convex, natural continuation.
 *   Day 9  She asks about the visit; she corrects who is visiting; recall returns
 *          the corrected text. She asks Wellness to forget the garden. She turns
 *          conversational memory off and nothing is recalled.
 *
 * Live against Backboard with BACKBOARD_API_KEY, else a labeled sandbox with the
 * same interface. Exits non-zero if any check fails.
 */

import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { backboardStatus } from "@/lib/env";
import { resetConversationMemoryProvider } from "@/integrations/backboard";
import { runWellnessTurn } from "@/agents/wellness/wellnessWorkflow";
import {
  continueFromContext,
  correctRememberedContext,
  forgetRememberedContext,
  listRememberedContext,
  recallConversationContext,
} from "@/agents/wellness/conversationContext";

const DAY = 24 * 60 * 60 * 1000;
function line(c = "─") { console.log(c.repeat(72)); }
const checks: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { checks.push({ name, ok }); console.log(`   ${ok ? "✓" : "✗"} ${name}`); }

async function main() {
  resetConversationMemoryProvider();
  const status = backboardStatus();
  line("═");
  console.log(`KINLINE: Backboard long-term conversational context (mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  const data = createInMemoryDataLayer();
  const userId = "margaret";
  const wellness = createAgent("wellness", { data, userId, consent: DEFAULT_CONSENT });
  await wellness.initialize();
  const memory = wellness.memory;
  const t0 = Date.now();

  // ---- Day 0 ------------------------------------------------------------
  const day0 = "I've been growing tomatoes and roses in my garden. My daughter Sarah is visiting next weekend with the grandkids. My doctor changed my blood pressure medication dose.";
  console.log(`\nDay 0  Margaret: "${day0}"`);
  const t = await runWellnessTurn({ text: day0, memory, userId, consent: DEFAULT_CONSENT, audit: wellness.audit, now: t0 });
  const remembered = await listRememberedContext(memory);
  for (const r of remembered) console.log(`   Convex [${r.category}/${r.topic}] "${r.fact}"  backboard=${r.syncState}`);
  console.log(`   ${t.syncs.find((s) => s.integration === "backboard")?.detail ?? ""}`);
  check("hobby + family visit stored canonically and indexed", t.contextSaved === 2 && remembered.every((r) => r.syncState === "synced"));
  check("health remark NOT indexed in Backboard", !remembered.some((r) => /medication|blood pressure/i.test(r.fact)));

  // ---- Day 5 ------------------------------------------------------------
  const q5 = "Do you remember what I told you about my garden?";
  console.log(`\nDay 5  Margaret: "${q5}"`);
  const r5 = await recallConversationContext({ memory, userId, consent: DEFAULT_CONSENT, query: q5, audit: wellness.audit, now: t0 + 5 * DAY });
  console.log(`   ${r5.detail}`);
  console.log(`   Wellness: ${continueFromContext(r5.recalled)}`);
  check("garden recalled, verified, 5 days old", r5.recalled[0]?.topic === "gardening" && r5.recalled[0]?.ageDays === 5);

  // ---- Day 9 ------------------------------------------------------------
  const q9 = "Did I tell you about my daughter's visit?";
  console.log(`\nDay 9  Margaret: "${q9}"`);
  const r9 = await recallConversationContext({ memory, userId, consent: DEFAULT_CONSENT, query: q9, now: t0 + 9 * DAY });
  console.log(`   Wellness: ${continueFromContext(r9.recalled)}`);
  check("family visit recalled", r9.recalled[0]?.category === "family_visit");

  console.log(`\n   Margaret: "Actually it's my granddaughter Emma who is visiting, not Sarah."`);
  const visit = (await listRememberedContext(memory)).find((r) => r.category === "family_visit")!;
  const c = await correctRememberedContext({ memory, userId, recordId: visit.recordId, fact: "My granddaughter Emma is visiting next weekend.", audit: wellness.audit, now: t0 + 9 * DAY });
  console.log(`   corrected: ok=${c.ok} backboardSynced=${c.ok && c.synced}`);
  const r9b = await recallConversationContext({ memory, userId, consent: DEFAULT_CONSENT, query: "who is visiting next weekend", now: t0 + 9 * DAY });
  console.log(`   Wellness: ${continueFromContext(r9b.recalled)}`);
  check("recall returns corrected text only", r9b.recalled.some((x) => /Emma/.test(x.fact)) && !r9b.recalled.some((x) => /Sarah/.test(x.fact)));

  console.log(`\n   Margaret: "Please forget about the garden."`);
  const garden = (await listRememberedContext(memory)).find((r) => r.topic === "gardening")!;
  const f = await forgetRememberedContext({ memory, recordId: garden.recordId, audit: wellness.audit });
  console.log(`   forgotten: ok=${f.ok} removedFromBackboard=${f.removedFromBackboard}`);
  const rg = await recallConversationContext({ memory, userId, consent: DEFAULT_CONSENT, query: "garden tomatoes roses", now: t0 + 9 * DAY });
  check("forgotten fact is not recalled", rg.recalled.length === 0);

  console.log(`\n   Margaret turns off conversational memory.`);
  const revoked = { ...DEFAULT_CONSENT, wellnessConversationMemory: false };
  const rr = await recallConversationContext({ memory, userId, consent: revoked, query: "who is visiting next weekend", now: t0 + 9 * DAY });
  console.log(`   ${rr.detail}`);
  check("nothing recalled once permission is withdrawn", rr.recalled.length === 0 && rr.blocked === "consent");

  line("═");
  const failed = checks.filter((x) => !x.ok);
  console.log(failed.length ? `✗ ${failed.length}/${checks.length} check(s) failed.` : `✓ All ${checks.length} checks passed (${status.mode}).`);
  line("═");
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
