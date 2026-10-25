import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run ONE Bitdeer inference on a conversation segment and return the full,
 * verifiable chain: the minimized text sent, the provider response id / latency /
 * raw output, every validation verdict, and the stored observations with their
 * request provenance. It goes through the Wellness agent's real
 * extractWellnessObservations tool, so consent, privacy filtering, validation,
 * storage and audit are exactly the production path.
 */
export async function POST(req: Request) {
  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "text too long" }, { status: 400 });

  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const { record } = await service.runTool("wellness", "extractWellnessObservations", { text });
  return NextResponse.json({
    ok: record.status === "success",
    summary: record.summary,
    error: record.error,
    result: record.output,
  });
}
