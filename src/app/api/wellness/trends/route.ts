import { NextResponse } from "next/server";
import { getDataLayer } from "@/agents/base/dataLayer";
import { getConsent } from "@/agents/consent";
import { createAgent } from "@/agents/registry";
import { AgentService } from "@/agents/service";
import { seedSleepHistory } from "@/agents/wellness/demoHistory";
import { getLongitudinalTrend, type Audience } from "@/agents/wellness/longitudinalTrends";
import { syncWellnessTimeSeries, TIMESERIES_CONSENT_KEY } from "@/agents/wellness/timeSeriesSync";
import type { Granularity } from "@/integrations/tigerdata";
import { tigerDataStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Longitudinal wellness trends (Tiger Data).
 *
 * GET ?granularity=weekly|monthly&audience=self|family
 *   Runs the Convex -> Tiger Data sync job, then returns sleep + energy trends
 *   compared with the person's history, with evidence and uncertainty. The
 *   family audience needs `caregiverWellness` consent and only sees quoted
 *   source sentences with `caregiverWellnessRaw`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const granularity: Granularity = url.searchParams.get("granularity") === "monthly" ? "monthly" : "weekly";
  const audience: Audience = url.searchParams.get("audience") === "family" ? "family" : "self";

  const user = getCurrentUser();
  const data = getDataLayer();
  const consent = await getConsent(data, user.id);
  const integration = tigerDataStatus();

  if (audience === "family" && !consent.caregiverWellness) {
    return NextResponse.json({ hidden: true, reason: "Wellness updates are hidden by consent settings.", integration });
  }
  if (consent[TIMESERIES_CONSENT_KEY] === false) {
    return NextResponse.json({ disabled: true, reason: "Trend tracking is turned off in privacy settings.", integration });
  }

  const wellness = createAgent("wellness", { data, userId: user.id });
  await wellness.initialize();
  const sync = await syncWellnessTimeSeries({ memory: wellness.memory, userId: user.id, consent, audit: wellness.audit });
  const [sleep, energy] = await Promise.all(
    (["sleep", "energy"] as const).map((metric) =>
      getLongitudinalTrend({ memory: wellness.memory, userId: user.id, metric, granularity, audience, consent }),
    ),
  );
  return NextResponse.json({ sleep, energy, sync, integration });
}

/**
 * POST { action: "seedDemo" }            -> write labeled fictional history into Convex, then sync.
 * POST { action: "converse", text }      -> a conversational observation through the real
 *                                           Wellness tool (extract -> validate -> Convex -> sync).
 */
export async function POST(req: Request) {
  let body: { action?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = getCurrentUser();

  if (body.action === "seedDemo") {
    const data = getDataLayer();
    const wellness = createAgent("wellness", { data, userId: user.id });
    await wellness.initialize();
    const seeded = await seedSleepHistory({ memory: wellness.memory, audit: wellness.audit });
    const sync = await syncWellnessTimeSeries({ memory: wellness.memory, userId: user.id, consent: await getConsent(data, user.id), audit: wellness.audit });
    return NextResponse.json({ ok: sync.ok, seeded, sync });
  }

  if (body.action === "converse") {
    const text = (body.text ?? "").trim();
    if (!text || text.length > 500) return NextResponse.json({ error: "text (1-500 chars) required" }, { status: 400 });
    const service = await AgentService.forUser(user.id);
    const { record } = await service.runTool("wellness", "processWellnessConversation", { text });
    return NextResponse.json({ ok: record.status === "success", record });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
