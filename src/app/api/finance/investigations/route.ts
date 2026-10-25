import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { ensureDemoDocuments, listInvestigations, loadAuthorizedDocuments } from "@/agents/finance/investigation/service";
import { renderDocument } from "@/agents/finance/investigation/documents";
import { convexStatus, factoryDroidStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Droid worker keeps running (via after()) once the start request returns.
export const maxDuration = 300;

async function snapshot(userId: string) {
  const data = getDataLayer();
  const finance = createAgent("finance", { data, userId, consent: await getConsent(data, userId) });
  await finance.initialize();
  await ensureDemoDocuments(finance.memory);
  const [docs, investigations] = await Promise.all([loadAuthorizedDocuments(finance.memory), listInvestigations(finance.memory, 5)]);
  const latest = investigations[0] ?? null;
  const approval = latest?.approvalId ? await finance.approvalService.get(latest.approvalId) : null;
  return {
    documents: docs.map((d) => ({ documentId: d.documentId, kind: d.kind, title: d.title, text: renderDocument(d) })),
    latest,
    history: investigations.slice(1).map((i) => ({ id: i.id, title: i.title, status: i.status, engine: i.engine, createdAt: i.createdAt })),
    approval: approval && approval.status === "pending" ? { id: approval.id, title: approval.title, description: approval.description } : null,
    approvalStatus: approval?.status ?? null,
    integrations: [factoryDroidStatus(), convexStatus()],
  };
}

/** Everything the /finance/investigate screen shows; polled while an investigation runs. */
export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json(await snapshot(user.id));
}

/** "Investigate this bill": queue an investigation through Finance's own tool and dispatch the worker. */
export async function POST() {
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const { record } = await service.runTool("finance", "investigateBill", {});
  if (record.status === "error") return NextResponse.json({ error: record.error ?? record.summary }, { status: 400 });
  return NextResponse.json({ record, ...(await snapshot(user.id)) });
}
