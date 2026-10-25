/**
 * Household analytics (Part 5, Track B, steps 10-11 + monthly reports).
 *
 * Computes de-identified monthly aggregates from the CANONICAL active observations
 * and publishes them to Snowflake (idempotent). Caregivers (e.g. Sarah) read only
 * the aggregates for households they are authorized for — never raw conversations.
 *
 * Consent is the gate in both directions:
 *   - publishing requires wellnessHouseholdAnalytics consent;
 *   - if that consent is revoked, aggregates are WITHDRAWN so they stop appearing
 *     in analytics (red-team case 21).
 */

import type { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { ScopedMemory } from "@/agents/base/types";
import { getAnalyticsProvider, type AggregateMetric, type HouseholdAggregate } from "@/integrations/snowflake";
import { activeObservations } from "./wellnessStore";

/** Demo household model. In production this comes from the org/household directory. */
export const DEMO_HOUSEHOLD = process.env.SAHAYA_DEMO_HOUSEHOLD?.trim() || "household-demo";

export function householdForUser(_userId: string): string {
  return DEMO_HOUSEHOLD;
}

/** Which households a requester may view analytics for. Elders see their own; a
 *  caregiver sees households they belong to. Anyone else sees nothing. */
export function authorizedHouseholdsFor(requester: { role: "elder" | "caregiver"; householdId: string }): string[] {
  return requester.householdId ? [requester.householdId] : [];
}

function periodOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7); // YYYY-MM
}

/** Compute this month's de-identified aggregates from canonical active observations. */
export async function computeMonthlyAggregates(
  memory: ScopedMemory,
  householdId: string,
  period: string,
): Promise<{ metric: AggregateMetric; value: number; observationCount: number }[]> {
  const obs = (await activeObservations(memory)).filter((o) => periodOf(o.createdAt) === period);

  const sleep = obs.filter((o) => o.type === "sleep_duration" && o.value !== undefined).map((o) => o.value!);
  const sleepAvg = sleep.length ? Math.round((sleep.reduce((s, v) => s + v, 0) / sleep.length) * 10) / 10 : 0;

  const energyVals: number[] = obs
    .filter((o) => o.type === "energy")
    .map((o) => (/energetic|full of energy/.test(o.description ?? "") ? 1 : /tired|exhausted|low energy|drained|fatigued/.test(o.description ?? "") ? -1 : 0));
  const energyScore = energyVals.length ? Math.round((energyVals.reduce((s, v) => s + v, 0) / energyVals.length) * 100) / 100 : 0;

  const concern = obs.filter((o) => ["mood", "pain", "appetite", "sleep_quality"].includes(o.type) && /tired|lonely|sad|down|poor|reduced|pain|ache|isolated/i.test(o.description ?? "")).length;

  return [
    { metric: "sleep_avg_hours", value: sleepAvg, observationCount: sleep.length },
    { metric: "energy_direction_score", value: energyScore, observationCount: energyVals.length },
    { metric: "checkin_count", value: obs.length, observationCount: obs.length },
    { metric: "concern_count", value: concern, observationCount: obs.length },
  ];
}

export interface AnalyticsSyncResult {
  ok: boolean;
  mode: "live" | "sandbox";
  published: number;
  withdrawn: number;
  period: string;
  detail: string;
}

/** Step 10: publish authorized aggregates to Snowflake (or withdraw on revocation). */
export async function updateHouseholdAnalytics(opts: {
  memory: ScopedMemory;
  userId: string;
  consent: ConsentSettings;
  period?: string;
  audit?: AuditLog;
  correlationId?: string;
}): Promise<AnalyticsSyncResult> {
  const householdId = householdForUser(opts.userId);
  const period = opts.period ?? periodOf(Date.now());
  const provider = getAnalyticsProvider();
  const mode = provider.backend === "snowflake" ? "live" : "sandbox";

  // Revocation: withdraw existing aggregates so they stop appearing.
  if (!opts.consent.wellnessHouseholdAnalytics) {
    try {
      const withdrawn = await provider.withdraw({ householdId });
      await opts.audit?.record({ actor: "wellness", action: "analytics.withdraw", correlationId: opts.correlationId, detail: { householdId, withdrawn } });
      return { ok: true, mode, published: 0, withdrawn, period, detail: `Consent off — withdrew ${withdrawn} aggregate(s).` };
    } catch (err) {
      return { ok: false, mode, published: 0, withdrawn: 0, period, detail: `Withdraw failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  try {
    const aggregates = await computeMonthlyAggregates(opts.memory, householdId, period);
    let published = 0;
    for (const a of aggregates) {
      await provider.publish({ householdId, period, metric: a.metric, value: a.value, observationCount: a.observationCount });
      published++;
    }
    await opts.audit?.record({ actor: "wellness", action: "analytics.publish", correlationId: opts.correlationId, detail: { householdId, period, published } });
    return { ok: true, mode, published, withdrawn: 0, period, detail: `Published ${published} aggregate(s) for ${period}.` };
  } catch (err) {
    return { ok: false, mode, published: 0, withdrawn: 0, period, detail: `Publish failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Step 11: a caregiver reads authorized household analytics (never raw data). */
export async function getHouseholdAnalytics(opts: {
  requester: { role: "elder" | "caregiver"; householdId: string };
  targetHouseholdId: string;
}): Promise<{ ok: boolean; aggregates: HouseholdAggregate[]; reason?: string }> {
  const authorized = authorizedHouseholdsFor(opts.requester);
  if (!authorized.includes(opts.targetHouseholdId)) {
    return { ok: false, aggregates: [], reason: "Not authorized for that household's analytics." };
  }
  const provider = getAnalyticsProvider();
  const aggregates = await provider.query({ householdId: opts.targetHouseholdId, authorizedHouseholds: authorized });
  return { ok: true, aggregates };
}

/** A readable monthly household care report built from aggregates (non-diagnostic). */
export function buildMonthlyReport(period: string, aggregates: HouseholdAggregate[]): {
  period: string;
  headline: string;
  lines: string[];
} {
  const by = (m: AggregateMetric) => aggregates.find((a) => a.metric === m);
  const sleep = by("sleep_avg_hours");
  const checkins = by("checkin_count");
  const concerns = by("concern_count");
  const lines: string[] = [];
  if (checkins) lines.push(`${checkins.value} wellness check-in(s) this month.`);
  if (sleep && sleep.observationCount > 0) lines.push(`Average reported sleep: ${sleep.value} hours (${sleep.observationCount} night(s) reported).`);
  if (concerns) lines.push(`${concerns.value} note(s) flagged as worth gentle attention.`);
  if (!aggregates.length) lines.push("No authorized aggregates for this period.");
  const headline =
    concerns && concerns.value >= 3
      ? "A few gentle concerns worth a check-in"
      : checkins && checkins.value > 0
        ? "Staying connected and steady"
        : "No activity recorded yet";
  return { period, headline, lines };
}
