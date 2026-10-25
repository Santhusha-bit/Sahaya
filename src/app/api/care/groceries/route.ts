import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getDataLayer } from "@/agents/base/dataLayer";
import { DEFAULT_USUAL } from "@/agents/care/groceryWorkflow";
import { apifyGroceryStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A live Apify run can take up to a couple of minutes.
export const maxDuration = 180;

/** The person's usual list plus the honest Apify integration status. */
export async function GET() {
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  await service.initializeAll();
  const prefs = await getDataLayer().memory.list({ namespace: "shared", userId: user.id, collection: "groceryPreferences", limit: 1 });
  const usual = prefs[0]?.data.usual;
  return NextResponse.json({
    status: apifyGroceryStatus(),
    usual: Array.isArray(usual) ? usual : DEFAULT_USUAL,
  });
}

/**
 * Grocery run actions. Each goes through Care's real tools, so validation,
 * the approval gate and the audit log apply exactly as in chat:
 *   discover  -> discoverGroceryProducts (runs the Apify Actor)
 *   cart      -> prepareGroceryCart (compare + cart + pending approval)
 *   saveUsual -> updateUsualGroceries
 */
export async function POST(req: Request) {
  let body: { action?: "discover" | "cart" | "saveUsual"; items?: unknown; retailer?: unknown; discoveryId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items.filter((i): i is string => typeof i === "string" && !!i.trim()) : undefined;
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);

  if (body.action === "discover") {
    const { record } = await service.runTool("care", "discoverGroceryProducts", {
      ...(items?.length ? { items } : {}),
      ...(typeof body.retailer === "string" && body.retailer.trim() ? { retailer: body.retailer.trim() } : {}),
    });
    return NextResponse.json({ ok: record.status === "success", record, status: apifyGroceryStatus() });
  }
  if (body.action === "cart") {
    if (typeof body.discoveryId !== "string") return NextResponse.json({ error: "discoveryId required" }, { status: 400 });
    const { record } = await service.runTool("care", "prepareGroceryCart", { discoveryId: body.discoveryId });
    return NextResponse.json({ ok: record.status === "success", record });
  }
  if (body.action === "saveUsual") {
    if (!items?.length) return NextResponse.json({ error: "items required" }, { status: 400 });
    const { record } = await service.runTool("care", "updateUsualGroceries", { items });
    return NextResponse.json({ ok: record.status === "success", record });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
