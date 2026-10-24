import { NextResponse } from "next/server";
import { agentMeta, AGENT_IDS } from "@/agents/registry";

export const runtime = "nodejs";

export async function GET() {
  const meta = agentMeta();
  return NextResponse.json({ agents: AGENT_IDS.map((id) => meta[id]) });
}
