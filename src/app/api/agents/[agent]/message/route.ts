import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { isAgentId } from "@/agents/base/types";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!isAgentId(agent)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });

  let body: { text?: string; via?: "voice" | "text" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "Message text is required" }, { status: 400 });

  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const { reply, deliveredEvents } = await service.sendMessage(agent, text, body.via ?? "text");
  const state = await service.agentState(agent);
  return NextResponse.json({ reply, deliveredEvents, ...state });
}
