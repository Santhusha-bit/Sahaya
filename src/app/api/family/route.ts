import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const feed = await service.familyFeed();
  const consent = await getConsent(getDataLayer(), user.id);
  return NextResponse.json({ ...feed, consent });
}
