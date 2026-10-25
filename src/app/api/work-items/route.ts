import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { getHouseholdCoordinator } from "@/integrations/jira";
import { evaluateGate, verifyHistory } from "@/agents/base/workItems";
import { jiraStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Work items for the household, with the gate's current verdict on each. */
export async function GET() {
  const user = getCurrentUser();
  const { service, backend } = getHouseholdCoordinator(user.id);
  const items = await service.list(user.id);
  return NextResponse.json({
    backend,
    jira: jiraStatus(),
    identityMode: user.authMode,
    reviewers: service.directory.list(user.id).map(({ id, name, roles }) => ({ id, name, roles })),
    items: items
      .slice()
      .reverse()
      .map((i) => ({
        ...i,
        chainIntact: verifyHistory(i.history) === -1,
        gate: evaluateGate(i, { agentId: i.assignedAgent, toolName: i.toolName, input: i.input }),
      })),
  });
}

/**
 * Review actions. Approvals go through WorkItemService (directory-resolved roles,
 * dual control); proposals and executions go through the real Guardian and
 * Finance tools, so the dashboard is never a privileged backdoor.
 */
export async function POST(req: Request) {
  let body: { action?: string; workItemId?: string; reviewerId?: string; reason?: string; scenario?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = getCurrentUser();
  const coord = getHouseholdCoordinator(user.id);
  const agents = await AgentService.forUser(user.id);

  switch (body.action) {
    case "propose": {
      const small = body.scenario === "small";
      const { record } = await agents.runTool("guardian", "delegateToAgent", small
        ? {
            assignedAgent: "finance",
            toolName: "fileBillingDispute",
            requestedAction: "Dispute duplicate $86 pharmacy charge on the May statement",
            input: { merchant: "Valley Pharmacy", amount: 86, statement: "2026-05" },
          }
        : {
            assignedAgent: "finance",
            toolName: "executePayment",
            requestedAction: "Pay $1,800 Sunrise Home Care invoice INV-1042 (new payee, verified by callback)",
            input: { amount: 1800, payee: "Sunrise Home Care", invoiceId: "INV-1042" },
          });
      return NextResponse.json({ ok: record.status === "success", record });
    }
    case "approve":
    case "reject": {
      if (!body.workItemId || !body.reviewerId) return NextResponse.json({ error: "workItemId and reviewerId required" }, { status: 400 });
      const r =
        body.action === "approve"
          ? await coord.service.approve(body.workItemId, { reviewerId: body.reviewerId })
          : await coord.service.reject(body.workItemId, { reviewerId: body.reviewerId, reason: body.reason });
      return NextResponse.json({ ok: r.ok, code: r.code, reason: r.reason });
    }
    case "execute": {
      if (!body.workItemId) return NextResponse.json({ error: "workItemId required" }, { status: 400 });
      const { record } = await agents.runTool("finance", "executeDelegatedWorkItem", { workItemId: body.workItemId });
      return NextResponse.json({ ok: record.status === "success", record });
    }
    case "sync": {
      if (!body.workItemId) return NextResponse.json({ error: "workItemId required" }, { status: 400 });
      if (!coord.syncFromJira) return NextResponse.json({ ok: false, reason: "Jira is not configured (sandbox)." });
      return NextResponse.json({ ok: true, ...(await coord.syncFromJira(body.workItemId)) });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
