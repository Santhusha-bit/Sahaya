import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { shoppingSnapshot } from "@/agents/care/shopping/service";
import { apifyStatus, cartesiaStatus, checkoutStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot(userId: string) {
  const data = getDataLayer();
  const care = createAgent("care", { data, userId, consent: await getConsent(data, userId) });
  await care.initialize();
  // Refresh tracking through the real tool so the order task advances too.
  await care.executeTool("trackOrder", {});
  const snap = await shoppingSnapshot({ memory: care.memory, approvals: care.approvalService });
  return { ...snap, integrations: [apifyStatus(), checkoutStatus(), cartesiaStatus()] };
}

/** Everything the accessible /shop screen shows: cart, pending approval, order tracking. */
export async function GET() {
  const user = getCurrentUser();
  return NextResponse.json(await snapshot(user.id));
}

/**
 * Cart edits from the /shop screen. Runs Care's own tools through the normal
 * executeTool path (validation, approval gate, audit). Approving a purchase is
 * NOT done here: it goes through /api/agents/care/approvals/:id like any other
 * approval.
 */
export async function POST(req: Request) {
  let body: { action?: string; cartId?: string; itemKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  let record;
  if (body.action === "build") {
    ({ record } = await service.runTool("care", "buildUsualCart", {}));
  } else if (body.action === "remove" && body.cartId && body.itemKey) {
    ({ record } = await service.runTool("care", "removeCartItem", { cartId: body.cartId, itemKey: body.itemKey }));
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ record, ...(await snapshot(user.id)) });
}
