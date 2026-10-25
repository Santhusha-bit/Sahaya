import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { isAgentId } from "@/agents/base/types";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ agent: string; id: string }> }) {
  const { agent, id } = await params;
  if (!isAgentId(agent)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });

  let body: { decision?: "approve" | "reject" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const decision = body.decision === "reject" ? "reject" : "approve";

  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const result = await service.decideApproval(agent, id, decision);
  if (!result.approval) return NextResponse.json({ error: "Approval not found or already decided" }, { status: 404 });
  const state = await service.agentState(agent);
  return NextResponse.json({ ...result, ...state });
}
