import { NextResponse } from "next/server";
import { getDataLayer } from "@/agents/base/dataLayer";
import { getCurrentUser } from "@/lib/user";
import { buildWellnessDashboard } from "@/agents/wellness/dashboardData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  const dashboard = await buildWellnessDashboard(getDataLayer(), user.id);
  return NextResponse.json({ user, ...dashboard });
}
