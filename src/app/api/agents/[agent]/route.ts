import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { agentMeta } from "@/agents/registry";
import { isAgentId } from "@/agents/base/types";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!isAgentId(agent)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const state = await service.agentState(agent);
  return NextResponse.json({ meta: agentMeta()[agent], ...state });
}
