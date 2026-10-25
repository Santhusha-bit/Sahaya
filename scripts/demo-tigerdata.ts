/**
 * npm run demo:tigerdata
 *
 * Shows the Tiger Data sleep time series and trend calculation over several days,
 * and proves idempotency: re-syncing the same observation does not change the
 * trend (no duplicate points). Live with TIGERDATA_URL + TIGERDATA_API_KEY, else a
 * labeled sandbox with the same interface.
 */

import { tigerDataStatus } from "@/lib/env";
import { getTimeSeriesProvider, resetTimeSeriesProvider } from "@/integrations/tigerdata";

function line(c = "─") { console.log(c.repeat(70)); }

async function main() {
  resetTimeSeriesProvider();
  const ts = getTimeSeriesProvider();
  const status = tigerDataStatus();
  const userId = "margaret";
  const day = 86_400_000;
  const base = 1_760_000_000_000; // fixed timestamp (scripts can't use Date.now via workflow)

  line("═");
  console.log(`Sahaya — Tiger Data wellness time series (mode: ${status.mode})`);
  console.log(status.detail);
  line("═");

  // A declining week of sleep.
  const nights = [7, 6.5, 6, 5, 4.5, 4, 4];
  for (let i = 0; i < nights.length; i++) {
    await ts.append({ observationId: `obs-${i}`, userId, metric: "sleep", value: nights[i], unit: "hours", at: base + i * day });
  }

  let trend = await ts.trend({ userId, metric: "sleep" });
  console.log(`\nSleep over ${trend.count} nights: avg ${trend.average}h, latest ${trend.latest}h, direction: ${trend.direction}`);

  // Re-sync the same observations (simulating a repeated sync). Trend must not change.
  const before = trend.count;
  for (let i = 0; i < nights.length; i++) {
    await ts.append({ observationId: `obs-${i}`, userId, metric: "sleep", value: nights[i], unit: "hours", at: base + i * day });
  }
  trend = await ts.trend({ userId, metric: "sleep" });
  console.log(`After a repeated sync: ${trend.count} nights (was ${before}). Idempotent: ${trend.count === before ? "✓" : "✗"}`);

  line("═");
  const ok = trend.direction === "declining" && trend.count === before;
  console.log(ok ? "✓ Trend computed correctly and re-sync did not inflate it." : "✗ Trend or idempotency failed.");
  line("═");
  if (!ok) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
