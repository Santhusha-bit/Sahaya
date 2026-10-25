import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Memory review actions (correct / forget) and analytics sync. These run through
 * the Wellness agent's real tools, so they are audited and consent-checked exactly
 * like any other action — the dashboard is not a privileged backdoor.
 */
export async function POST(req: Request) {
  let body: {
    action?: "correct" | "forget" | "correctContext" | "forgetContext" | "syncAnalytics";
    recordId?: string;
    fact?: string;
    description?: string;
    value?: number;
    unit?: "hours" | "minutes";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);

  if (body.action === "correct") {
    if (!body.recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });
    const { record } = await service.runTool("wellness", "correctRememberedObservation", {
      recordId: body.recordId,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.value !== undefined ? { value: body.value } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
    });
    return NextResponse.json({ ok: record.status === "success", record });
  }

  if (body.action === "forget") {
    if (!body.recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });
    const { record } = await service.runTool("wellness", "forgetRememberedObservation", { recordId: body.recordId });
    return NextResponse.json({ ok: record.status === "success", record });
  }

  if (body.action === "correctContext") {
    if (!body.recordId || !body.fact) return NextResponse.json({ error: "recordId and fact required" }, { status: 400 });
    const { record } = await service.runTool("wellness", "correctRememberedContext", { recordId: body.recordId, fact: body.fact });
    return NextResponse.json({ ok: record.status === "success", record });
  }

  if (body.action === "forgetContext") {
    if (!body.recordId) return NextResponse.json({ error: "recordId required" }, { status: 400 });
    const { record } = await service.runTool("wellness", "forgetRememberedContext", { recordId: body.recordId });
    return NextResponse.json({ ok: record.status === "success", record });
  }

  if (body.action === "syncAnalytics") {
    const { record } = await service.runTool("wellness", "updateHouseholdAnalytics", {});
    return NextResponse.json({ ok: record.status === "success", record });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
