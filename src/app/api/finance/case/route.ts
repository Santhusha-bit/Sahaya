import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { createAgent } from "@/agents/registry";
import { getConsent } from "@/agents/consent";
import { getDataLayer } from "@/agents/base/dataLayer";
import { CaseActionDenied, caseSnapshot, declineCase, evidencePacket, reviewFinding, reviewerActor } from "@/agents/finance/investigation/caseService";
import { claudeStatus, convexStatus, disputeChannelStatus } from "@/lib/env";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_CHARS = 130_000;

async function financeAgent(userId: string) {
  const data = getDataLayer();
  const finance = createAgent("finance", { data, userId, consent: await getConsent(data, userId) });
  await finance.initialize();
  return finance;
}

async function snapshot(userId: string) {
  const finance = await financeAgent(userId);
  // Refresh provider responses through Finance's own tool so the audit trail records them.
  await finance.executeTool("trackDisputeCase", {});
  const snap = await caseSnapshot({ memory: finance.memory, approvals: finance.approvalService });
  return { ...snap, integrations: [claudeStatus(), disputeChannelStatus(), convexStatus()] };
}

/** The /finance/case screen: latest case, pending approval, audit verification. ?export=1 downloads the evidence packet. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (new URL(req.url).searchParams.get("export")) {
    const finance = await financeAgent(user.id);
    const packet = await evidencePacket({ memory: finance.memory });
    if (!packet) return NextResponse.json({ error: "No case yet" }, { status: 404 });
    return new NextResponse(JSON.stringify(packet, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="sahaya-case-${packet.caseId}.json"`,
      },
    });
  }
  return NextResponse.json(await snapshot(user.id));
}

/**
 * Case actions from the screen.
 *   open    -> Finance's openBillInvestigation tool (the agent does the work)
 *   review  -> the signed-in person dismisses/restores a finding (reviewer capability)
 *   decline -> the person chooses not to send anything
 * Approving the letter is NOT here: it goes through /api/agents/finance/approvals/:id
 * like every other approval, which runs submitDisputeRequest behind the gate.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "Documents are too large." }, { status: 413 });
  let body: {
    action?: string;
    sample?: boolean;
    documents?: { fileName: string; text: string }[];
    caseId?: string;
    findingId?: string;
    decision?: "dismiss" | "restore";
    note?: string;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const user = await getCurrentUser();
  const service = await AgentService.forUser(user.id);

  try {
    if (body.action === "open") {
      const input = body.sample ? { useSampleDocuments: true } : { documents: body.documents ?? [] };
      const { record } = await service.runTool("finance", "openBillInvestigation", input);
      return NextResponse.json({ record, ...(await snapshot(user.id)) });
    }

    const finance = await financeAgent(user.id);
    const ctx = finance.buildContext(`corr_case_${Date.now()}`, () => {});
    if (body.action === "review" && body.caseId && body.findingId && (body.decision === "dismiss" || body.decision === "restore")) {
      const out = await reviewFinding(ctx, { caseId: body.caseId, findingId: body.findingId, decision: body.decision, note: body.note }, reviewerActor(user.id));
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: 409 });
    } else if (body.action === "decline" && body.caseId) {
      const out = await declineCase(ctx, { caseId: body.caseId, reason: body.note }, reviewerActor(user.id), (id) => service.decideApproval("finance", id, "reject"));
      if (!out.ok) return NextResponse.json({ error: out.error }, { status: 409 });
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json(await snapshot(user.id));
  } catch (err) {
    if (err instanceof CaseActionDenied) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
}
