import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  await service.initializeAll();
  const events = await service.allEvents(60);
  return NextResponse.json({ events });
}
