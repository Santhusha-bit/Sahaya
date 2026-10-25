import { NextResponse } from "next/server";
import { allIntegrationStatuses } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";
import { getDataLayer } from "@/agents/base/dataLayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json({
    user,
    backend: getDataLayer().backend,
    integrations: allIntegrationStatuses(),
  });
}
