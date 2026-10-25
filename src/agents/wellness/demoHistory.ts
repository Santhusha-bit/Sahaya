/**
 * Fictional multi-week sleep history for demos.
 *
 * Writes through the CANONICAL path (saveObservation into Convex/scoped memory),
 * never straight into Tiger Data, so the demo exercises the real sync job.
 * Every seeded record is labeled: provenance provider "demo-seed" and the
 * evidence text says "(demo history)". Re-seeding is a no-op thanks to the
 * store's same-day dedup.
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ScopedMemory } from "@/agents/base/types";
import { bucketStartOf } from "@/integrations/tigerdata";
import { id, now as nowMs } from "@/lib/id";
import { DEFAULT_TIMEZONE } from "./longitudinalTrends";
import type { CanonicalObservation } from "./observationSchema";
import { saveObservation } from "./wellnessStore";

const DAY = 86_400_000;

/** Reported hours per night, oldest week first. Weekly averages 7.1 / 6.6 / 5.8. */
const PAST_WEEKS: number[][] = [
  [7, 7.5, 7, 6.5, 7.5],
  [6.5, 7, 6.5, 6.5, 6.5],
  [6, 5.5, 6, 6, 5.5],
];
/** Earlier nights of the current week (only the ones already in the past are used). */
const THIS_WEEK = [5.5, 5];

function seeded(hours: number, at: number): CanonicalObservation {
  return {
    id: id("obs"),
    type: "sleep_duration",
    value: hours,
    unit: "hours",
    source: "self_report",
    requiresConfirmation: false,
    evidence: `I slept about ${hours} hours. (fictional demo history)`,
    provenance: { provider: "demo-seed", model: "fictional-history", mode: "sandbox", extractedAt: at },
  };
}

export async function seedSleepHistory(opts: {
  memory: ScopedMemory;
  now?: number;
  timezone?: string;
  audit?: AuditLog;
}): Promise<{ saved: number; duplicates: number }> {
  const at = opts.now ?? nowMs();
  const tz = opts.timezone ?? DEFAULT_TIMEZONE;
  // bucketStart is UTC midnight of the local Monday; +12h lands on that local
  // calendar day for any timezone within +/-12h of UTC.
  const thisMonday = bucketStartOf(at, "weekly", tz);
  const plan: { hours: number; at: number }[] = [];

  PAST_WEEKS.forEach((nights, w) => {
    const monday = thisMonday - (PAST_WEEKS.length - w) * 7 * DAY;
    nights.forEach((hours, d) => plan.push({ hours, at: monday + d * DAY + 12 * 3_600_000 }));
  });
  const earlierThisWeek = [0, 1, 2, 3, 4, 5, 6]
    .map((d) => thisMonday + d * DAY + 12 * 3_600_000)
    .filter((t) => t < at - 3_600_000 && bucketStartOf(t, "weekly", tz) === thisMonday);
  earlierThisWeek.slice(-THIS_WEEK.length).forEach((t, i) => plan.push({ hours: THIS_WEEK[i], at: t }));

  let saved = 0;
  let duplicates = 0;
  for (const p of plan) {
    const { duplicate } = await saveObservation(opts.memory, seeded(p.hours, p.at), { audit: opts.audit });
    if (duplicate) duplicates++;
    else saved++;
  }
  return { saved, duplicates };
}
