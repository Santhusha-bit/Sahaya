/**
 * npm run demo:credit
 *
 * Finance credit & identity review over the CRS Credit API:
 *   user asks -> approval -> authorization -> CRS sandbox requests -> findings ->
 *   Claude explanation (validated) -> next steps -> audit trail.
 *
 * Live when CRS_USERNAME/CRS_PASSWORD are set (real CRS sandbox requests for test
 * persona P13); otherwise an offline fixture of a recorded CRS sandbox response,
 * clearly labeled sandbox. Claude is live when ANTHROPIC_API_KEY is set.
 */

import { readFileSync } from "node:fs";

// Load .env.local before anything reads env (same as serve-guardian).
try {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env.local -> sandbox */
}

const { crsStatus, claudeStatus } = await import("@/lib/env");
const { createInMemoryDataLayer } = await import("@/agents/base/memoryStore");
const { createAgent } = await import("@/agents/registry");
const { crsConfig } = await import("@/integrations/crs");

function line(c = "─") {
  console.log(c.repeat(72));
}

async function main() {
  const userId = "demo-credit-user";
  const data = createInMemoryDataLayer();
  const finance = createAgent("finance", { data, userId });
  await finance.initialize();

  line("═");
  console.log("KINLINE: Finance credit & identity review (CRS Credit API)");
  console.log(`CRS:    ${crsStatus().mode.toUpperCase()}: ${crsStatus().detail}`);
  console.log(`Claude: ${claudeStatus().mode.toUpperCase()}`);
  line("═");

  // 1. The person asks; Finance asks for approval before any CRS request.
  const ask = "Is someone applying for credit in my name?";
  console.log(`\nUser: "${ask}"`);
  const deferred = await finance.executeTool("reviewCreditAndIdentity", { purpose: "identity_protection_review" });
  console.log(`Finance: ${deferred.result.summary}`);
  console.log("User approves the request.");

  // 2. Approved: run the review.
  const { result } = await finance.executeTool("reviewCreditAndIdentity", { purpose: "identity_protection_review" }, { approved: true });
  if (!result.ok) {
    console.error(`\nReview failed: ${result.summary}`);
    process.exit(1);
  }
  const d = result.data as any;

  line();
  console.log(`CRS REQUESTS (${d.mode}) base ${crsConfig().baseUrl}`);
  for (const r of d.requests) {
    console.log(`\n  ${r.method} ${r.endpoint}`);
    console.log(`  -> HTTP ${r.status}  RequestID ${r.requestId ?? "-"}  ${r.latencyMs} ms  sha256 ${r.responseSha256.slice(0, 16)}...`);
    console.log(`  body ${JSON.stringify(r.requestBody)}`);
  }
  for (const f of d.failures) console.log(`\n  FAILED ${f.product}: ${f.error}`);

  line();
  console.log(`RESPONSE HIGHLIGHTS: ${JSON.stringify(d.facts)}`);
  line();
  console.log(`FINDINGS (overall: ${d.overall.toUpperCase()})`);
  for (const f of d.findings) {
    console.log(`\n  [${f.severity.toUpperCase()}] ${f.id}: ${f.title}`);
    for (const e of f.evidence.slice(0, 4)) console.log(`      evidence: ${e.source} ${e.field} = ${e.value}`);
  }

  line();
  console.log(`EXPLANATION (source: ${d.explanationSource}${d.rejectedReasons.length ? `; rejected model draft: ${d.rejectedReasons.join(", ")}` : ""})`);
  console.log(`\n${result.summary}`);

  line();
  console.log("AUDIT TRAIL");
  for (const e of await finance.audit.list()) {
    const detail = JSON.stringify(e.detail ?? {});
    console.log(`  ${new Date(e.at).toISOString()}  ${e.action.padEnd(28)} ${detail.length > 110 ? `${detail.slice(0, 110)}...` : detail}`);
  }
  line("═");
  console.log(`✓ Review ${d.reviewId} recorded (${d.mode}). Bank transactions are not part of CRS data and were not reviewed.`);
  line("═");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
