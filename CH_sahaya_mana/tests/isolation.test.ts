import { describe, expect, it } from "vitest";
import { ScopedAgentStore } from "@/agents/base/AgentStore";
import { MemoryStore } from "@/agents/base/MemoryStore";
import { ToolRegistry } from "@/agents/base/ToolRegistry";
import { AGENT_IDS } from "@/agents/base/types";
import { AGENT_DEFINITIONS } from "@/agents";
import { careTools } from "@/agents/care/careTools";
import { ScriptedLLM, USER, realRuntime, testRuntime, text, toolUse, userCtx } from "./helpers";

describe("four independent agents", () => {
  it("instantiates four distinct agent objects with distinct prompts", () => {
    const { runtime } = realRuntime();
    const agents = runtime.list();
    expect(agents.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    expect(new Set(agents).size).toBe(4);
    expect(new Set(agents.map((a) => a.definition.systemPrompt)).size).toBe(4);
    expect(agents.map((a) => a.constructor.name).sort()).toEqual(
      ["CareAgent", "FinanceAgent", "GuardianAgent", "WellnessAgent"],
    );
  });

  it("gives each agent exactly the tools the spec assigns, with no overlap", () => {
    const required: Record<string, string[]> = {
      guardian: ["analyzeSuspiciousConversation", "initiateTrustedVerification", "createSecurityIncident", "requestEmergencyAssistance", "notifyTrustedContact", "createHumanAssistanceRequest", "scheduleHelper", "trackAssistanceResponse"],
      care: ["getMedicationSchedule", "sendMedicationReminder", "recordMedicationConfirmation", "preparePharmacyRefill", "createGroceryList", "searchProducts", "createShoppingCart", "requestOrderApproval", "suggestMeals", "updatePantry"],
      wellness: ["startConversationalCheckIn", "extractWellnessObservations", "saveWellnessMemory", "analyzeLongitudinalPatterns", "generateWellnessSummary", "scheduleFollowUp", "requestCaregiverNotification", "arrangeFamilyCall"],
      finance: ["analyzeMedicalBill", "compareInsuranceDocuments", "auditCareFacilityInvoice", "detectRecurringCharges", "analyzeAuthorizedTransactions", "prepareDispute", "requestFinancialApproval", "searchBenefits", "generateCareCostProjection"],
    };
    const { runtime } = realRuntime();
    const seen = new Set<string>();
    for (const agent of runtime.list()) {
      const names = agent.listTools().map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(required[agent.id]));
      for (const n of names) {
        expect(seen.has(n), `${n} registered on two agents`).toBe(false);
        seen.add(n);
      }
    }
  });

  it("sends each agent's own prompt and tool set to the model", async () => {
    const llm = new ScriptedLLM([text("hi from guardian"), text("hi from care")]);
    const { runtime } = realRuntime(llm);
    await runtime.get("guardian").processMessage(userCtx, "hello");
    await runtime.get("care").processMessage(userCtx, "hello");
    const [g, c] = llm.requests;
    expect(g.system).toBe(AGENT_DEFINITIONS.guardian.systemPrompt);
    expect(c.system).toBe(AGENT_DEFINITIONS.care.systemPrompt);
    expect(g.tools.map((t) => t.name)).toContain("analyzeSuspiciousConversation");
    expect(g.tools.map((t) => t.name)).not.toContain("createShoppingCart");
    expect(c.tools.map((t) => t.name)).toContain("createShoppingCart");
  });
});

describe("tool isolation", () => {
  it("refuses to register another agent's tool", () => {
    const registry = new ToolRegistry("guardian");
    expect(() => registry.register(careTools[0])).toThrow(/ISOLATION|belongs to care/);
  });

  it("an agent cannot execute another agent's tool", async () => {
    const { runtime } = realRuntime();
    const res = await runtime.get("guardian").executeTool(userCtx, "createShoppingCart", { items: [], deliveryDate: "2026-10-25" });
    expect(res).toMatchObject({ status: "error", code: "TOOL_NOT_FOUND" });
  });

  it("rejects invalid tool input before running the handler", async () => {
    const { runtime, calls } = testRuntime();
    const res = await runtime.get("care").executeTool(userCtx, "saveNote", { note: "" });
    expect(res).toMatchObject({ status: "error", code: "VALIDATION_FAILED" });
    expect(calls.saveNote).toBeUndefined();
  });

  it("fails honestly when a required integration is unavailable", async () => {
    const { runtime } = testRuntime();
    const res = await runtime.get("guardian").executeTool(userCtx, "callForHelp", { who: "daughter" });
    expect(res).toMatchObject({ status: "error", code: "INTEGRATION_UNAVAILABLE" });
  });

  it("retries retryable failures", async () => {
    const { runtime, calls } = testRuntime();
    const res = await runtime.get("care").executeTool(userCtx, "flaky", {});
    expect(res).toMatchObject({ status: "success", attempts: 2 });
    expect(calls.flaky).toHaveLength(2);
  });
});

describe("memory isolation", () => {
  it("scoped stores cannot touch another agent's namespaces", async () => {
    const root = new MemoryStore();
    const care = new ScopedAgentStore(root, "care", AGENT_DEFINITIONS.care.memoryNamespaces);
    await expect(care.listMemory(USER, "finance.bills")).rejects.toThrow(/may not access/);
    await expect(
      care.putMemory({ id: "x", userId: USER, namespace: "wellness.symptoms", key: "k", value: 1, text: "", createdAt: 0, updatedAt: 0 }),
    ).rejects.toThrow(/may not access/);
  });

  it("records written by one agent are invisible to another even with the same namespace name", async () => {
    const root = new MemoryStore();
    const a = new ScopedAgentStore(root, "care", ["shared.name"]);
    const b = new ScopedAgentStore(root, "finance", ["shared.name"]);
    await a.putMemory({ id: "1", userId: USER, namespace: "shared.name", key: "k", value: "secret", text: "secret", createdAt: 0, updatedAt: 0 });
    expect(await b.listMemory(USER, "shared.name")).toEqual([]);
    expect(await b.getMemory(USER, "shared.name", "k")).toBeNull();
  });

  it("an agent cannot read another agent's tasks, approvals or jobs by id", async () => {
    const { runtime, store } = testRuntime();
    const task = await runtime.get("care").planTask(userCtx, "noop");
    await expect(runtime.get("guardian").getTaskStatus(userCtx, task.id)).rejects.toThrow(/another agent/);
    const finance = new ScopedAgentStore(store, "finance", []);
    await expect(finance.getTask(task.id)).rejects.toThrow(/another agent/);
  });

  it("keeps conversation history separate per agent", async () => {
    const llm = new ScriptedLLM([text("care reply"), text("guardian reply")]);
    const { runtime } = realRuntime(llm);
    await runtime.get("care").processMessage(userCtx, "my pills are on the counter");
    await runtime.get("guardian").processMessage(userCtx, "someone called me");
    const careHistory = (await runtime.get("care").listConversation(userCtx)).map((m) => m.text);
    const guardianHistory = (await runtime.get("guardian").listConversation(userCtx)).map((m) => m.text);
    expect(careHistory).toEqual(["my pills are on the counter", "care reply"]);
    expect(guardianHistory).toEqual(["someone called me", "guardian reply"]);
    // And the guardian model call never saw the care conversation.
    expect(JSON.stringify(llm.requests[1].messages)).not.toContain("pills");
  });

  it("shared household data requires an explicit per-agent grant", async () => {
    const root = new MemoryStore();
    await root.setSharedData(USER, "dietaryPreferences", { lowSodium: true });
    const care = new ScopedAgentStore(root, "care", []);
    const finance = new ScopedAgentStore(root, "finance", []);
    await root.setSharedAccess({ userId: USER, agentId: "care", key: "dietaryPreferences", enabled: true });
    expect(await care.readShared(USER, "dietaryPreferences")).toEqual({ lowSodium: true });
    await expect(finance.readShared(USER, "dietaryPreferences")).rejects.toThrow(/no permission/);
  });
});

describe("conversation loop", () => {
  it("runs tools, tracks the task, and persists history", async () => {
    const llm = new ScriptedLLM([toolUse("saveNote", { note: "milk" }), text("Saved milk.")]);
    const { runtime, calls } = testRuntime(llm);
    const care = runtime.get("care");
    const turn = await care.processMessage(userCtx, "remember milk");
    expect(turn.reply).toBe("Saved milk.");
    expect(calls.saveNote).toEqual([{ note: "milk" }]);
    const task = await care.getTaskStatus(userCtx, turn.taskId!);
    expect(task.status).toBe("completed");
    expect(task.steps[0]).toMatchObject({ toolName: "saveNote", status: "succeeded", attempts: 1 });
    // Second request carried the tool_result back to the model.
    expect(JSON.stringify(llm.requests[1].messages)).toContain("tool_result");
  });

  it("is honest when the LLM is unavailable", async () => {
    const { MemoryStore: MS } = await import("@/agents/base/MemoryStore");
    const { UnavailableLLMClient } = await import("@/agents/base/llm");
    const { createSahayaRuntime } = await import("@/agents");
    const runtime = createSahayaRuntime({ store: new MS(), llm: new UnavailableLLMClient() });
    const turn = await runtime.get("wellness").processMessage(userCtx, "hello");
    expect(turn.status).toBe("llm_unavailable");
    expect(turn.reply).toMatch(/isn't configured/);
  });

  it("only lets the user converse with their own agents", async () => {
    const { runtime } = realRuntime();
    await expect(
      runtime.get("care").processMessage({ userId: USER, actor: { id: "cg", role: "caregiver" } }, "hi"),
    ).rejects.toThrow(/may not converse/);
    await expect(
      runtime.get("care").processMessage({ userId: USER, actor: { id: "someone_else", role: "older_adult" } }, "hi"),
    ).rejects.toThrow(/own agents/);
  });
});
