/**
 * npm run demo:snowflake
 *
 * Shows authorized household analytics: aggregates are published, Sarah (an
 * authorized caregiver) reads them, an outsider is refused, a repeated publish is
 * idempotent, and revoking consent withdraws the aggregates. Only de-identified
 * numbers ever cross — never raw conversations. Live with SNOWFLAKE_ACCOUNT +
 * SNOWFLAKE_TOKEN, else a labeled sandbox with the same interface.
 */

import { snowflakeStatus } from "@/lib/env";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { resetAnalyticsProvider } from "@/integrations/snowflake";
import { DEMO_HOUSEHOLD, getHouseholdAnalytics, updateHouseholdAnalytics } from "@/agents/wellness/householdAnalytics";

function line(c = "─") { console.log(c.repeat(70)); }

async function main() {
  resetAnalyticsProvider();
  const status = snowflakeStatus();
  const data = createInMemoryDataLayer();
  const wellness = createAgent("wellness", { data, userId: "margaret", consent: DEFAULT_CONSENT });
  await wellness.initialize();

  line("═");
  console.log(`KINLINE — Snowflake household analytics (mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  // Seed a few observations, then publish aggregates.
  await wellness.executeTool("extractWellnessObservations", { text: "I slept around five hours last night and felt tired." });
  await wellness.executeTool("extractWellnessObservations", { text: "I only slept four hours and felt lonely today." });

  const pub1 = await updateHouseholdAnalytics({ memory: wellness.memory, userId: "margaret", consent: DEFAULT_CONSENT });
  console.log(`\nPublish: ${pub1.detail}`);
  const pub2 = await updateHouseholdAnalytics({ memory: wellness.memory, userId: "margaret", consent: DEFAULT_CONSENT });
  console.log(`Repeat publish (idempotent): ${pub2.detail}`);

  // Sarah, an authorized caregiver in the same household, reads aggregates.
  const sarah = { role: "caregiver" as const, householdId: DEMO_HOUSEHOLD };
  const authorized = await getHouseholdAnalytics({ requester: sarah, targetHouseholdId: DEMO_HOUSEHOLD });
  console.log(`\nSarah (authorized) sees ${authorized.aggregates.length} aggregate(s):`);
  for (const a of authorized.aggregates) console.log(`   - ${a.metric} = ${a.value} (${a.observationCount} obs)`);

  // An outsider from a different household is refused.
  const outsider = { role: "caregiver" as const, householdId: "other-household" };
  const refused = await getHouseholdAnalytics({ requester: outsider, targetHouseholdId: DEMO_HOUSEHOLD });
  console.log(`\nOutsider sees ${refused.aggregates.length} aggregate(s) (expected 0). Reason: ${refused.reason ?? "n/a"}`);

  // Revoke analytics consent -> aggregates withdrawn.
  const revoked = await updateHouseholdAnalytics({ memory: wellness.memory, userId: "margaret", consent: { ...DEFAULT_CONSENT, wellnessHouseholdAnalytics: false } });
  console.log(`\nAfter revoking consent: ${revoked.detail}`);
  const afterRevoke = await getHouseholdAnalytics({ requester: sarah, targetHouseholdId: DEMO_HOUSEHOLD });
  console.log(`Sarah now sees ${afterRevoke.aggregates.length} aggregate(s) (expected 0).`);

  line("═");
  const ok =
    authorized.aggregates.length > 0 &&
    refused.aggregates.length === 0 &&
    afterRevoke.aggregates.length === 0;
  console.log(ok ? "✓ Authorized read works; outsider refused; revocation withdraws analytics." : "✗ An analytics authorization/consent guarantee failed.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
