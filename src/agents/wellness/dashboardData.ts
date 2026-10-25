/**
 * Server-side assembler for the Unified Wellness Dashboard (Part 5, Track B).
 *
 * Gathers everything one workspace needs — recent observations, personal memory,
 * historical context, trends, the monthly household report, consent, integration
 * status, and the audit timeline — from the canonical data layer and the
 * integration providers. Read-only; all mutations go through the agent's tools.
 */

import type { DataLayer } from "@/agents/base/types";
import { createAgent } from "@/agents/registry";
import { getConsent } from "@/agents/consent";
import { AuditLog } from "@/agents/base/audit";
import { wellnessIntegrationStatuses, cartesiaStatus, auth0Status, type IntegrationStatus } from "@/lib/env";
import { getPersonalMemoryProvider } from "@/integrations/moss";
import { listContinuity } from "./continuityMemory";

export interface ContinuityItem {
  id: string;
  kind: string;
  text: string;
  createdAt: number;
  sync: string;
  reason?: string;
}
import { getVoiceProvider } from "@/integrations/cartesia";
import { getTimeSeriesProvider, type Trend } from "@/integrations/tigerdata";
import { activeObservations, type StoredObservation } from "./wellnessStore";
import {
  DEMO_HOUSEHOLD,
  buildMonthlyReport,
  getHouseholdAnalytics,
  householdForUser,
} from "./householdAnalytics";
import type { HouseholdAggregate } from "@/integrations/snowflake";

export interface WellnessDashboard {
  observations: StoredObservation[];
  continuity: ContinuityItem[];
  sleepTrend: Trend;
  energyTrend: Trend;
  report: { period: string; headline: string; lines: string[] };
  analytics: HouseholdAggregate[];
  consent: Record<string, boolean>;
  integrations: IntegrationStatus[];
  audit: { actor: string; action: string; at: number; detail?: Record<string, unknown> }[];
  backends: { timeseries: string; personalMemory: string; voice: string };
}

export async function buildWellnessDashboard(data: DataLayer, userId: string): Promise<WellnessDashboard> {
  const wellness = createAgent("wellness", { data, userId });
  await wellness.initialize();

  const consent = await getConsent(data, userId);
  const observations = (await activeObservations(wellness.memory)).slice().reverse();

  // Continuity memory: the Convex ledger (what Wellness remembers, and whether
  // each cue was synced to Moss or kept Convex-only). Tolerate failure.
  const moss = getPersonalMemoryProvider();
  let continuity: ContinuityItem[] = [];
  try {
    continuity = consent.wellnessMemory
      ? (await listContinuity(wellness.memory)).slice(0, 20).map((r) => ({
          id: r.recordId,
          kind: r.topic,
          text: r.text,
          createdAt: r.lastDiscussedAt,
          sync: r.sync,
          reason: r.reason,
        }))
      : [];
  } catch {
    continuity = [];
  }

  // Trends (Tiger Data).
  const ts = getTimeSeriesProvider();
  let sleepTrend: Trend = { metric: "sleep", count: 0, average: null, latest: null, direction: "insufficient_data", points: [] };
  let energyTrend: Trend = { metric: "energy", count: 0, average: null, latest: null, direction: "insufficient_data", points: [] };
  try {
    [sleepTrend, energyTrend] = await Promise.all([
      ts.trend({ userId, metric: "sleep" }),
      ts.trend({ userId, metric: "energy" }),
    ]);
  } catch {
    /* keep defaults */
  }

  // Household analytics + monthly report (the elder views their own household).
  const householdId = householdForUser(userId);
  const analyticsRes = await getHouseholdAnalytics({
    requester: { role: "elder", householdId },
    targetHouseholdId: householdId,
  });
  const period = new Date(observations[0]?.createdAt ?? Date.now()).toISOString().slice(0, 7);
  const report = buildMonthlyReport(period, analyticsRes.aggregates);

  // Audit timeline (shared namespace), filtered to Wellness actors.
  const auditLog = new AuditLog(data.memory, userId);
  const audit = (await auditLog.list({ limit: 100 }))
    .filter((e) => e.actor === "wellness")
    .map((e) => ({ actor: e.actor, action: e.action, at: e.at, detail: e.detail }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);

  // Voice (Cartesia) + Auth0 are mapped Wellness services. Surface them honestly
  // alongside the core integrations so the dashboard reflects every wired service.
  const voice = getVoiceProvider();
  const integrations: IntegrationStatus[] = [...wellnessIntegrationStatuses(), cartesiaStatus(), auth0Status()];

  return {
    observations,
    continuity,
    sleepTrend,
    energyTrend,
    report,
    analytics: analyticsRes.aggregates,
    consent,
    integrations,
    audit,
    backends: { timeseries: ts.backend, personalMemory: moss.backend, voice: voice.backend },
  };
}

export { DEMO_HOUSEHOLD };
