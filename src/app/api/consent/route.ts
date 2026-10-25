import { NextResponse } from "next/server";
import { getConsent, setConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { CROSS_AGENT_RULES } from "@/agents/base/policy";
import { getCurrentUser } from "@/lib/user";
import { TIMESERIES_CONSENT_KEY } from "@/agents/wellness/timeSeriesSync";
import { getTimeSeriesProvider } from "@/integrations/tigerdata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  const consent = await getConsent(getDataLayer(), user.id);
  return NextResponse.json({ consent, rules: CROSS_AGENT_RULES.map((r) => ({ source: r.source, target: r.target, type: r.type, consentKey: r.consentKey, description: r.description })) });
}

export async function POST(req: Request) {
  let body: Record<string, boolean>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = await getCurrentUser();
  const consent = await setConsent(getDataLayer(), user.id, body);
  // Revoking trend tracking purges the Tiger Data mirror immediately (Convex,
  // the canonical record, is untouched).
  if (body[TIMESERIES_CONSENT_KEY] === false) {
    await getTimeSeriesProvider().purgeUser(user.id).catch(() => 0);
  }
  return NextResponse.json({ consent });
}
