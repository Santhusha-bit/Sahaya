/**
 * Household care export: the controlled pipeline from Convex (canonical) to
 * Snowflake (analytics).
 *
 * This is NOT an agent and holds no agent memory scope. It reads exactly two
 * declared sources, each gated by its own consent key, and reduces every record
 * to a de-identified fact (category, outcome, day). Anything else in the record
 * (medication names, notes, request text, amounts, user ids) is dropped here and
 * would be rejected by the strict fact schema in the Snowflake layer anyway.
 *
 *   care/confirmations          -> medication_confirmation: taken | skipped
 *   guardian assistance events  -> assistance_request: completed | open | declined
 *
 * Revoking a category's consent withdraws that category's facts from Snowflake,
 * so it stops appearing in reports. Re-exporting is idempotent.
 */

import { createHash } from "node:crypto";
import { AuditLog } from "@/agents/base/audit";
import type { ConsentSettings } from "@/agents/base/policy";
import type { DataLayer } from "@/agents/base/types";
import { householdForUser } from "@/agents/wellness/householdAnalytics";
import {
  getAnalyticsProvider,
  isPeriod,
  type CareFact,
  type CareFactCategory,
  type CareFactOutcome,
} from "@/integrations/snowflake";

interface SourceRecord {
  sourceId: string;
  createdAt: number;
  outcome: CareFactOutcome;
}

interface CareSource {
  category: CareFactCategory;
  consentKey: string;
  label: string;
  collect(data: DataLayer, userId: string): Promise<SourceRecord[]>;
}

export const CARE_SOURCES: CareSource[] = [
  {
    category: "medication_confirmation",
    consentKey: "householdAnalyticsMedication",
    label: "Medication confirmations",
    async collect(data, userId) {
      const rows = await data.memory.list({ namespace: "care", userId, collection: "confirmations" });
      return rows.flatMap((r) =>
        typeof r.data.taken === "boolean"
          ? [{ sourceId: r.id, createdAt: r.createdAt, outcome: r.data.taken ? ("taken" as const) : ("skipped" as const) }]
          : [],
      );
    },
  },
  {
    category: "assistance_request",
    consentKey: "householdAnalyticsAssistance",
    label: "Assistance requests",
    async collect(data, userId) {
      const events = (await data.events.list({ userId, targetAgent: "guardian" })).filter((e) => e.type === "assistance.request");
      const tasks = await data.tasks.list({ userId, agentId: "guardian" });
      const taskFor = new Map(tasks.filter((t) => t.correlationId).map((t) => [t.correlationId!, t]));
      return events.map((e) => {
        const task = taskFor.get(e.correlationId);
        // The bus marks an event "completed" once Guardian ACCEPTS it, so only the
        // coordinating task says whether help was actually delivered.
        // declined = refused at the bus, or the coordinating task was abandoned.
        const outcome: CareFactOutcome =
          e.status === "rejected" || e.status === "blocked" || task?.status === "failed" || task?.status === "cancelled"
            ? "declined"
            : task?.status === "completed"
              ? "completed"
              : "open";
        return { sourceId: e.id, createdAt: e.createdAt, outcome };
      });
    },
  },
];

export function periodOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Opaque, stable id: the same source record always maps to the same fact. */
function factIdFor(householdId: string, category: CareFactCategory, sourceId: string): string {
  return createHash("sha256").update(`${householdId}|${category}|${sourceId}`).digest("hex").slice(0, 24);
}

export function toCareFacts(householdId: string, category: CareFactCategory, periods: string[], records: SourceRecord[]): CareFact[] {
  return records
    .filter((r) => periods.includes(periodOf(r.createdAt)))
    .map((r) => ({
      factId: factIdFor(householdId, category, r.sourceId),
      householdId,
      period: periodOf(r.createdAt),
      category,
      outcome: r.outcome,
      occurredOn: new Date(r.createdAt).toISOString().slice(0, 10),
    }));
}

export interface CareExportResult {
  ok: boolean;
  mode: "live" | "sandbox";
  householdId: string;
  periods: string[];
  categories: { category: CareFactCategory; shared: boolean; exported: number; withdrawn: number; error?: string }[];
  detail: string;
}

/** Export the household's consented care records for the given periods. */
export async function exportHouseholdCareFacts(opts: {
  data: DataLayer;
  userId: string;
  consent: ConsentSettings;
  periods: string[];
  correlationId?: string;
}): Promise<CareExportResult> {
  const householdId = householdForUser(opts.userId);
  const provider = getAnalyticsProvider();
  const mode = provider.backend === "snowflake" ? "live" : "sandbox";
  const periods = [...new Set(opts.periods)].filter(isPeriod);
  if (!periods.length) {
    return { ok: false, mode, householdId, periods, categories: [], detail: "No valid period to export." };
  }

  const categories: CareExportResult["categories"] = [];
  for (const source of CARE_SOURCES) {
    const shared = opts.consent[source.consentKey] === true;
    try {
      if (!shared) {
        const withdrawn = await provider.withdrawCareFacts({ householdId, category: source.category });
        categories.push({ category: source.category, shared, exported: 0, withdrawn });
        continue;
      }
      const facts = toCareFacts(householdId, source.category, periods, await source.collect(opts.data, opts.userId));
      const { loaded } = await provider.replaceCareFacts({ householdId, category: source.category, periods, facts });
      categories.push({ category: source.category, shared, exported: loaded, withdrawn: 0 });
    } catch (err) {
      categories.push({ category: source.category, shared, exported: 0, withdrawn: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ok = categories.every((c) => !c.error);
  // Audit counts only; never the records themselves.
  await new AuditLog(opts.data.memory, opts.userId)
    .record({
      actor: "analytics",
      action: "analytics.care_export",
      correlationId: opts.correlationId,
      detail: { householdId, periods, mode, categories: categories.map(({ category, shared, exported, withdrawn }) => ({ category, shared, exported, withdrawn })) },
    })
    .catch(() => undefined);

  const exported = categories.reduce((s, c) => s + c.exported, 0);
  const withdrawn = categories.reduce((s, c) => s + c.withdrawn, 0);
  return {
    ok,
    mode,
    householdId,
    periods,
    categories,
    detail: ok
      ? `Exported ${exported} de-identified fact(s) for ${periods.join(", ")}${withdrawn ? `; withdrew ${withdrawn} after consent was turned off` : ""}.`
      : `Export incomplete: ${categories.filter((c) => c.error).map((c) => `${c.category} (${c.error})`).join("; ")}`,
  };
}
