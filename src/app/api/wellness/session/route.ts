import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wellness conversation sessions. GET opens a session and returns a greeting that
 * picks up from what Wellness remembers (or the first-time welcome). POST
 * { action: "end", sessionId } closes it and syncs continuity. Both run through
 * the agent's real tools, so consent checks and audit apply.
 */
export async function GET() {
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const { record } = await service.runTool("wellness", "openWellnessSession", {});
  return NextResponse.json({ ok: record.status === "success", ...((record.output as object | undefined) ?? {}) });
}

export async function POST(req: Request) {
  let body: { action?: "end"; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action !== "end") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const { record } = await service.runTool("wellness", "endWellnessSession", body.sessionId ? { sessionId: body.sessionId } : {});
  return NextResponse.json({ ok: record.status === "success", summary: record.summary });
}
