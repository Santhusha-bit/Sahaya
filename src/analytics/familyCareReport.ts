/**
 * Monthly family care summary.
 *
 * Sahaya retrieves ONLY aggregate rows from Snowflake (the GROUP BY result for
 * care facts, plus the Wellness aggregates already published there) and turns
 * them into a short, non-diagnostic report for the caregiver. Access is limited
 * to households the requester is authorized for; anyone else gets a refusal, not
 * an empty report.
 */

import type { ConsentSettings } from "@/agents/base/policy";
import { authorizedHouseholdsFor } from "@/agents/wellness/householdAnalytics";
import {
  getAnalyticsProvider,
  isPeriod,
  type CareSummaryRow,
  type HouseholdAggregate,
} from "@/integrations/snowflake";
import { CARE_SOURCES, previousPeriod } from "./householdCareExport";

export interface FamilyCareReport {
  householdId: string;
  period: string;
  monthLabel: string;
  source: "snowflake" | "sandbox";
  headline: string;
  medication: { taken: number; skipped: number; rate: number | null; previousRate: number | null; activeDays: number } | null;
  assistance: { total: number; completed: number; open: number; declined: number; previousTotal: number } | null;
  wellness: { checkins: number; sleepAvgHours: number | null } | null;
  lines: string[];
  /** Categories left out because the older adult chose not to share them. */
  notShared: string[];
  generatedAt: number;
}

export type Requester = { role: "elder" | "caregiver"; householdId: string };

export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function rateOf(row: CareSummaryRow | undefined): number | null {
  if (!row) return null;
  const answered = row.outcomes.taken + row.outcomes.skipped;
  return answered ? row.outcomes.taken / answered : null;
}

/** Pure: build the report from aggregate rows. */
export function buildFamilyCareReport(input: {
  householdId: string;
  period: string;
  source: "snowflake" | "sandbox";
  care: CareSummaryRow[];
  wellness: HouseholdAggregate[];
  consent: ConsentSettings;
}): FamilyCareReport {
  const { period } = input;
  const prev = previousPeriod(period);
  const row = (p: string, c: CareSummaryRow["category"]) => input.care.find((r) => r.period === p && r.category === c);
  const shared = (category: CareSummaryRow["category"]) =>
    input.consent[CARE_SOURCES.find((s) => s.category === category)!.consentKey] === true;

  const lines: string[] = [];
  const notShared = CARE_SOURCES.filter((s) => !shared(s.category)).map((s) => s.label);
  const prevLabel = monthLabel(prev).split(" ")[0];

  let medication: FamilyCareReport["medication"] = null;
  if (shared("medication_confirmation")) {
    const cur = row(period, "medication_confirmation");
    const rate = rateOf(cur);
    const previousRate = rateOf(row(prev, "medication_confirmation"));
    medication = {
      taken: cur?.outcomes.taken ?? 0,
      skipped: cur?.outcomes.skipped ?? 0,
      rate,
      previousRate,
      activeDays: cur?.activeDays ?? 0,
    };
    if (rate === null) {
      lines.push("No medication confirmations were recorded this month.");
    } else {
      const trend =
        previousRate === null
          ? ""
          : Math.round(rate * 100) === Math.round(previousRate * 100)
            ? `, the same as ${prevLabel}`
            : `, ${rate > previousRate ? "up" : "down"} from ${pct(previousRate)} in ${prevLabel}`;
      lines.push(`Medications confirmed taken ${medication.taken} of ${medication.taken + medication.skipped} times (${pct(rate)})${trend}.`);
      lines.push(`Confirmations were recorded on ${medication.activeDays} day(s).`);
    }
  }

  let assistance: FamilyCareReport["assistance"] = null;
  if (shared("assistance_request")) {
    const cur = row(period, "assistance_request");
    assistance = {
      total: cur?.total ?? 0,
      completed: cur?.outcomes.completed ?? 0,
      open: cur?.outcomes.open ?? 0,
      declined: cur?.outcomes.declined ?? 0,
      previousTotal: row(prev, "assistance_request")?.total ?? 0,
    };
    if (!assistance.total) {
      lines.push("No requests for help this month.");
    } else {
      const parts = [`${assistance.completed} completed`];
      if (assistance.open) parts.push(`${assistance.open} still open`);
      if (assistance.declined) parts.push(`${assistance.declined} not carried out`);
      lines.push(`${assistance.total} request(s) for help: ${parts.join(", ")}.`);
    }
  }

  const monthWellness = input.wellness.filter((a) => a.period === period);
  const checkins = monthWellness.find((a) => a.metric === "checkin_count");
  const sleep = monthWellness.find((a) => a.metric === "sleep_avg_hours");
  const wellness: FamilyCareReport["wellness"] = checkins && checkins.value > 0
    ?{ checkins: checkins.value, sleepAvgHours: sleep && sleep.observationCount > 0 ? sleep.value : null }
    : null;
  if (wellness) {
    lines.push(
      `${wellness.checkins} wellness check-in(s)${wellness.sleepAvgHours !== null ? `; average reported sleep ${wellness.sleepAvgHours} hours` : ""}.`,
    );
  }

  const anyActivity = (medication?.rate ?? null) !== null || (assistance?.total ?? 0) > 0 || (wellness?.checkins ?? 0) > 0;
  const headline = !anyActivity
    ? `No shared care activity recorded for ${monthLabel(period)} yet`
    : medication?.rate !== null && medication?.rate !== undefined && medication.rate < 0.8
      ? "Some doses were missed this month, worth a gentle check-in"
      : assistance && assistance.open > 0
        ? `${assistance.open} request(s) for help still open`
        : "A steady month of care";

  return {
    householdId: input.householdId,
    period,
    monthLabel: monthLabel(period),
    source: input.source,
    headline,
    medication,
    assistance,
    wellness,
    lines,
    notShared,
    generatedAt: Date.now(),
  };
}

/** Retrieve aggregates for an authorized household and build its monthly report. */
export async function getFamilyCareReport(opts: {
  requester: Requester;
  targetHouseholdId: string;
  period: string;
  consent: ConsentSettings;
}): Promise<{ ok: true; report: FamilyCareReport } | { ok: false; reason: string }> {
  if (!isPeriod(opts.period)) return { ok: false, reason: "Period must be YYYY-MM." };
  const authorized = authorizedHouseholdsFor(opts.requester);
  if (!authorized.includes(opts.targetHouseholdId)) {
    return { ok: false, reason: "Not authorized for that household's reports." };
  }
  const provider = getAnalyticsProvider();
  const [care, wellness] = await Promise.all([
    provider.summarizeCare({ householdId: opts.targetHouseholdId, authorizedHouseholds: authorized, periods: [opts.period, previousPeriod(opts.period)] }),
    provider.query({ householdId: opts.targetHouseholdId, authorizedHouseholds: authorized }),
  ]);
  return {
    ok: true,
    report: buildFamilyCareReport({
      householdId: opts.targetHouseholdId,
      period: opts.period,
      source: provider.backend,
      care,
      wellness,
      consent: opts.consent,
    }),
  };
}
