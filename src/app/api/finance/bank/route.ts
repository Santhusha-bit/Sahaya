import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { currentSuggestions, getConnection, latestAnalysis, simulateNewPurchase } from "@/agents/finance/nessie/service";
import { getNessieClient } from "@/integrations/nessie";
import { claudeStatus, convexStatus, nessieStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshot(userId: string) {
  const data = getDataLayer();
  const finance = createAgent("finance", { data, userId, consent: await getConsent(data, userId) });
  await finance.initialize();
  const conn = await getConnection(finance.memory);
  const analysis = await latestAnalysis(finance.memory);
  const approval = (await finance.approvalService.list("pending")).find((a) => a.toolName === "connectSandboxBankAccount") ?? null;
  return {
    connection: conn
      ? { status: conn.data.status, nickname: conn.data.nickname, last4: conn.data.last4, backend: conn.data.backend, authorizedAt: conn.data.authorizedAt }
      : null,
    approval: approval ? { id: approval.id, title: approval.title, description: approval.description } : null,
    analysis: analysis ? { ...analysis, seenTransactionIds: undefined } : null,
    suggestions: analysis ? await currentSuggestions(finance.memory) : [],
    integrations: [nessieStatus(), claudeStatus(), convexStatus()],
  };
}

/** Everything the /money screen shows: connection, latest review, suggestions. */
export async function GET() {
  return NextResponse.json(await snapshot((await getCurrentUser()).id));
}

/**
 * Actions from the /money screen. Finance's own tools run through executeTool
 * (validation, approval gate, audit). Approving bank access is NOT done here:
 * it goes through /api/agents/finance/approvals/:id like any other approval.
 * "simulate" is demo tooling that plays the bank posting a new purchase.
 */
export async function POST(req: Request) {
  let body: { action?: string; actionId?: string; decision?: string; scenario?: string; merchant?: string; amount?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  let record;
  let simulated;
  switch (body.action) {
    case "connect":
      ({ record } = await service.runTool("finance", "connectSandboxBankAccount", {}));
      break;
    case "analyze":
      ({ record } = await service.runTool("finance", "runSpendingAnalysis", {}));
      break;
    case "decide":
      ({ record } = await service.runTool("finance", "reviewSuggestedAction", { actionId: body.actionId, decision: body.decision }));
      break;
    case "disconnect":
      ({ record } = await service.runTool("finance", "disconnectBankAccount", {}));
      break;
    case "simulate": {
      const data = getDataLayer();
      const finance = createAgent("finance", { data, userId: user.id });
      const input =
        body.scenario === "custom" && body.merchant && Number(body.amount) > 0
          ? { scenario: "custom" as const, merchant: String(body.merchant), amount: Number(body.amount) }
          : { scenario: "double_charge" as const };
      try {
        const { purchase, merchant } = await simulateNewPurchase({ memory: finance.memory, nessie: getNessieClient() }, input);
        simulated = { merchant, amount: purchase.amount, date: purchase.purchase_date };
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : "Could not add the purchase" }, { status: 409 });
      }
      break;
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ record, simulated, ...(await snapshot(user.id)) });
}
