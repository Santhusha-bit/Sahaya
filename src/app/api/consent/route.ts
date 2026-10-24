import { NextResponse } from "next/server";
import { getConsent, setConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { CROSS_AGENT_RULES } from "@/agents/base/policy";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = getCurrentUser();
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
  const user = getCurrentUser();
  const consent = await setConsent(getDataLayer(), user.id, body);
  return NextResponse.json({ consent });
}
