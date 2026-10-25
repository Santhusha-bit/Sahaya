import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { householdForUser } from "@/agents/wellness/householdAnalytics";
import { exportHouseholdCareFacts, periodOf, previousPeriod } from "@/analytics/householdCareExport";
import { getFamilyCareReport } from "@/analytics/familyCareReport";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Monthly family care summary.
 *   GET  ?period=YYYY-MM[&household=...]  read the report from Snowflake aggregates
 *   POST { period? }                      export consented records, then read
 * The requester can only ever see their own household; asking for another one is
 * refused with 403.
 */
async function readReport(period: string, household?: string | null) {
  const user = await getCurrentUser();
  const householdId = householdForUser(user.id);
  const res = await getFamilyCareReport({
    requester: { role: user.role, householdId },
    targetHouseholdId: household || householdId,
    period,
    consent: await getConsent(getDataLayer(), user.id),
  });
  if (res.ok) return { status: 200, body: { ok: true, report: res.report } };
  return { status: res.reason.startsWith("Not authorized") ? 403 : 400, body: { ok: false, error: res.reason } };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const { status, body } = await readReport(url.searchParams.get("period") || periodOf(Date.now()), url.searchParams.get("household"));
  return NextResponse.json(body, { status });
}

export async function POST(req: Request) {
  const input = (await req.json().catch(() => ({}))) as { period?: string };
  const period = input.period || periodOf(Date.now());
  const user = await getCurrentUser();
  const data = getDataLayer();

  // Refresh this month's Wellness aggregates through the agent's own audited tool.
  const service = await AgentService.forUser(user.id);
  await service.runTool("wellness", "updateHouseholdAnalytics", {}).catch(() => undefined);

  const exported = await exportHouseholdCareFacts({
    data,
    userId: user.id,
    consent: await getConsent(data, user.id),
    periods: [period, previousPeriod(period)],
  });
  const { status, body } = await readReport(period);
  return NextResponse.json({ ...body, export: exported }, { status });
}
