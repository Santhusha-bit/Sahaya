import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { BridgedAssistanceRequestSchema } from "@/integrations/fetchai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Guardian's intake for the Fetch.ai uAgents bridge. The Guardian uAgent
 * (services/uagents/guardian_agent.py) posts here after verifying the sender's
 * uAgent identity; the TS Guardian then runs its own policy + consent checks and
 * creates the coordination task. Set GUARDIAN_AGENT_URL=<app>/api/bridge/guardian.
 *
 * Auth: when SAHAYA_BRIDGE_TOKEN is set, the x-sahaya-bridge-token header must
 * match. Without a token the endpoint only runs outside production.
 */
export async function POST(req: Request) {
  const token = process.env.SAHAYA_BRIDGE_TOKEN?.trim();
  if (token) {
    if (req.headers.get("x-sahaya-bridge-token") !== token) {
      return NextResponse.json({ status: "rejected", reason: "bad_bridge_token" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ status: "rejected", reason: "bridge_token_required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ status: "rejected", reason: "invalid_json" }, { status: 400 });
  }
  const parsed = BridgedAssistanceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ status: "rejected", reason: "invalid_request_schema" }, { status: 400 });
  }

  const service = await AgentService.forUser(parsed.data.user_id);
  const response = await service.acceptBridgedAssistance(parsed.data);
  return NextResponse.json(response);
}
