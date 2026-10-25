import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the Droid CLI behind @factory/droid-sdk/node. It behaves like a
 * scoped Droid session: it asks the permission handler before using tools,
 * calls Sahaya's in-process MCP tools, and returns a structured result.
 */
const droidMock = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  permissionDecisions: [] as { tool: string; outcome: string }[],
  overchargeOverride: null as number | null,
}));

vi.mock("@factory/droid-sdk/node", () => {
  const ToolConfirmationOutcome = { ProceedOnce: "proceed_once", Cancel: "cancel" };
  const ToolConfirmationType = { McpTool: "mcp_tool", Execute: "exec" };
  type MockTool = { name: string; handler: (i: Record<string, unknown>) => Promise<unknown> };
  return {
    AutonomyLevel: { Low: "low" },
    OutputFormatType: { JsonSchema: "json_schema" },
    ToolConfirmationOutcome,
    ToolConfirmationType,
    tool: (name: string, _d: string, _s: unknown, handler: MockTool["handler"]) => ({ name, handler }),
    createSdkMcpServer: (o: { name: string; tools: MockTool[] }) => ({ ...o, close: async () => undefined }),
    createSession: async (opts: Record<string, any>) => {
      droidMock.sessions.push(opts);
      if (!opts.mcpServers) {
        // Probe session: report the CLI's built-in tools.
        return { id: "probe", listTools: async () => [{ id: "Execute" }, { id: "Read" }, { id: "FetchUrl" }], close: async () => undefined };
      }
      const server = opts.mcpServers[0] as { name: string; tools: MockTool[] };
      const run = (name: string, input: Record<string, unknown>) => server.tools.find((t) => t.name === name)!.handler(input);
      const ask = async (tool: string, details: Record<string, unknown>) => {
        const outcome = await opts.permissionHandler({ toolUses: [{ toolUse: { name: tool, id: "x", input: {} }, details }], options: [] });
        droidMock.permissionDecisions.push({ tool, outcome });
        return outcome;
      };
      return {
        id: "droid-session-1",
        close: async () => undefined,
        async *stream(_prompt: string, msgOpts: Record<string, any>) {
          expect(msgOpts.files.length).toBe(2);
          // A tool outside the allowlist is refused by Sahaya's permission handler.
          await ask("Execute", { type: ToolConfirmationType.Execute, command: "curl https://example.com" });
          await ask(`${server.name}___get_document`, { type: ToolConfirmationType.McpTool, serverName: server.name, toolName: "get_document" });
          yield { type: "tool_call", name: "report_progress", toolUseId: "1", input: {} };
          await run("report_progress", { step: "Reading the documents" });
          yield { type: "tool_call", name: "reconcile_bill_with_eob", toolUseId: "2", input: {} };
          const rec = (JSON.parse(String(await run("reconcile_bill_with_eob", { billDocumentId: "doc_bayview_statement", eobDocumentId: "doc_goldenstate_eob" })))) as {
            amountDueOnStatement: number;
            patientResponsibilityPerEob: number;
            excessBilled: number;
          };
          yield { type: "assistant", text: "The statement asks for more than the EOB allows.", message: {} };
          yield {
            type: "result",
            sessionId: "droid-session-1",
            success: true,
            subtype: "success",
            durationMs: 4200,
            turnCount: 3,
            text: "",
            tokenUsage: { inputTokens: 1200, outputTokens: 300 },
            structuredOutput: {
              summary: "The hospital is asking for more than your insurance says you owe.",
              amountDueOnStatement: rec.amountDueOnStatement,
              patientResponsibilityPerInsurer: rec.patientResponsibilityPerEob,
              estimatedOvercharge: droidMock.overchargeOverride ?? rec.excessBilled,
              findings: [
                { title: "ER visit billed twice", category: "duplicate_charge", amount: 1450, lineIds: ["B1", "B2", "E2"], evidence: "E2 denied as duplicate.", calculation: "1 x 1450" },
              ],
              disputeRecommended: true,
              recommendedNextSteps: ["Ask for a corrected bill."],
              confidence: "high",
            },
            error: null,
            messages: [],
          };
        },
      };
    },
  };
});

import { AgentService } from "@/agents/service";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { findDuplicateCharges, pickBillAndEob, reconcileBillWithEob } from "@/agents/finance/investigation/analysis";
import { sampleErBillDocuments } from "@/agents/finance/investigation/documents";
import { verifyReport } from "@/agents/finance/investigation/report";
import { getInvestigation, runInvestigation, startInvestigation } from "@/agents/finance/investigation/service";

const USER = "demo-investigation";

async function setup() {
  const data = createInMemoryDataLayer();
  const service = new AgentService(data, USER);
  const finance = createAgent("finance", { data, userId: USER });
  await finance.initialize();
  return { data, service, finance };
}

afterEach(() => {
  delete process.env.FACTORY_API_KEY;
  droidMock.sessions.length = 0;
  droidMock.permissionDecisions.length = 0;
  droidMock.overchargeOverride = null;
});

describe("bill calculations (deterministic, cent-exact)", () => {
  const { bill, eob } = pickBillAndEob(sampleErBillDocuments("Test Patient"));

  it("finds the duplicated ER visit", () => {
    expect(findDuplicateCharges(bill!)).toEqual([
      { code: "99284", serviceDate: "2026-09-12", lineIds: ["B1", "B2"], chargeEach: 1450, extraCharged: 1450 },
    ]);
  });

  it("reconciles the statement with the EOB", () => {
    const rec = reconcileBillWithEob(bill!, eob!);
    expect(rec.amountDueOnStatement).toBe(1812.4);
    expect(rec.patientResponsibilityPerEob).toBe(102.4);
    expect(rec.excessBilled).toBe(1710);
    expect(rec.planPaidOnEob).toBe(rec.insurancePaidOnBill);
    expect(rec.lines.filter((l) => l.notPatientResponsibility).map((l) => l.billLineId)).toEqual(["B2", "B8"]);
    expect(rec.billLinesMissingFromEob).toEqual([]);
  });
});

describe("investigation without Factory Droid (labeled local engine)", () => {
  it("queues a pending task, runs, verifies, and gates the dispute behind approval", async () => {
    const { data, service, finance } = await setup();
    const inv = await startInvestigation({ memory: finance.memory, tasks: finance.taskService });
    expect(inv.status).toBe("pending");
    expect(inv.engine).toBe("local");
    expect((await data.tasks.get(inv.taskId))?.status).toBe("planning");

    const done = (await runInvestigation(finance, inv.id))!;
    expect(done.status).toBe("completed");
    expect(done.verification?.verified).toBe(true);
    expect(done.verification?.verifiedOvercharge).toBe(1710);
    expect(done.steps.some((s) => s.kind === "progress")).toBe(true);
    expect(done.steps.some((s) => s.label === "Factory Droid not configured")).toBe(true);

    // Dispute drafted, but nothing submitted until the person approves.
    expect(done.disputeId).toBeTruthy();
    const approval = await data.approvals.get(done.approvalId!);
    expect(approval?.status).toBe("pending");
    expect(approval?.toolName).toBe("requestFinancialApproval");
    expect(await finance.memory.list("financialActions")).toHaveLength(0);
    expect((await data.tasks.get(inv.taskId))?.status).toBe("awaiting_approval");

    const decided = await service.decideApproval("finance", done.approvalId!, "approve");
    expect(decided.approval?.status).toBe("approved");
    const actions = await finance.memory.list("financialActions");
    expect(actions).toHaveLength(1);
    expect(actions[0].data.amount).toBe(1710);
  });

  it("runs a pending investigation only once", async () => {
    const { finance } = await setup();
    const inv = await startInvestigation({ memory: finance.memory, tasks: finance.taskService });
    await runInvestigation(finance, inv.id);
    const again = await runInvestigation(finance, inv.id);
    expect(again?.status).toBe("completed");
    expect((await finance.approvalService.list("pending")).length).toBe(1);
  });

  it("refuses documents that were not authorized for investigation", async () => {
    const { finance } = await setup();
    await expect(
      startInvestigation({ memory: finance.memory, tasks: finance.taskService }, { documentIds: ["doc_someone_elses_bank_statement"] }),
    ).rejects.toThrow(/Not authorized/);
  });

  it("is reachable from a Finance chat turn", async () => {
    const { service, finance } = await setup();
    const { reply } = await service.sendMessage("finance", "Investigate this bill");
    expect(reply.toolCalls[0].toolName).toBe("investigateBill");
    expect(reply.toolCalls[0].status).toBe("success");
    const id = (reply.toolCalls[0].output as { investigationId: string }).investigationId;
    expect(await getInvestigation(finance.memory, id)).toBeTruthy();
  });
});

describe("investigation on Factory Droid (SDK mocked at the CLI boundary)", () => {
  it("runs a scoped Droid session and captures its steps and report", async () => {
    process.env.FACTORY_API_KEY = "test-key";
    const { finance } = await setup();
    const inv = await startInvestigation({ memory: finance.memory, tasks: finance.taskService });
    expect(inv.engine).toBe("factory-droid");

    const done = (await runInvestigation(finance, inv.id))!;
    expect(done.status).toBe("completed");
    expect(done.droidSessionId).toBe("droid-session-1");
    expect(done.tokenUsage).toEqual({ inputTokens: 1200, outputTokens: 300 });

    // Every built-in tool the CLI reported was disabled; only Sahaya's tools remain.
    const main = droidMock.sessions.find((s) => s.mcpServers)!;
    expect(main.disabledToolIds).toEqual(["Execute", "Read", "FetchUrl"]);
    expect(main.apiKey).toBe("test-key");
    expect(droidMock.permissionDecisions).toEqual([
      { tool: "Execute", outcome: "cancel" },
      { tool: "sahaya_investigation___get_document", outcome: "proceed_once" },
    ]);
    expect(done.steps.some((s) => s.kind === "permission" && s.label.includes("Execute"))).toBe(true);
    expect(done.steps.some((s) => s.kind === "scope")).toBe(true);
    expect(done.steps.some((s) => s.kind === "progress" && s.label === "Reading the documents")).toBe(true);

    expect(done.verification?.verified).toBe(true);
    expect(done.approvalId).toBeTruthy();
  });

  it("does not trust Droid numbers that Finance cannot reproduce", async () => {
    process.env.FACTORY_API_KEY = "test-key";
    droidMock.overchargeOverride = 4394;
    const { finance } = await setup();
    const inv = await startInvestigation({ memory: finance.memory, tasks: finance.taskService });
    const done = (await runInvestigation(finance, inv.id))!;
    expect(done.status).toBe("completed");
    expect(done.verification?.verified).toBe(false);
    expect(done.approvalId).toBeUndefined();
    expect(done.disputeId).toBeUndefined();
    expect(done.financeSummary).toMatch(/didn't match/);
  });
});

describe("report verification", () => {
  it("flags line ids that are not in the documents", () => {
    const docs = sampleErBillDocuments("Test Patient");
    const v = verifyReport(
      {
        summary: "x",
        amountDueOnStatement: 1812.4,
        patientResponsibilityPerInsurer: 102.4,
        estimatedOvercharge: 1710,
        findings: [{ title: "made up", category: "other", amount: 10, lineIds: ["B99"], evidence: "none", calculation: "" }],
        disputeRecommended: true,
        recommendedNextSteps: [],
        confidence: "low",
      },
      docs,
    );
    expect(v.verified).toBe(false);
    expect(v.unknownLineIds).toEqual(["B99"]);
  });
});
