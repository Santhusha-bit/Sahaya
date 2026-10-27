import { z } from "zod";
import { AgentRuntime } from "@/agents/base/AgentRuntime";
import { BaseAgent, type AgentDefinition, type AgentDeps } from "@/agents/base/BaseAgent";
import type { LLMClient, LLMRequest, LLMResponse } from "@/agents/base/llm";
import { MemoryStore } from "@/agents/base/MemoryStore";
import { DEFAULT_POLICY } from "@/agents/base/policy";
import { defineTool } from "@/agents/base/ToolRegistry";
import type { AgentContext, AgentEvent, AgentId, ContentBlock } from "@/agents/base/types";
import { createSahayaRuntime } from "@/agents";

export const USER = "user_ada";
export const CAREGIVER = "cg_sam";

export const userCtx: AgentContext = { userId: USER, actor: { id: USER, role: "older_adult" } };
export const caregiverCtx: AgentContext = { userId: USER, actor: { id: CAREGIVER, role: "caregiver" } };

/** Scripted LLM: returns queued responses in order and records every request it receives. */
export class ScriptedLLM implements LLMClient {
  readonly available = true;
  readonly requests: LLMRequest[] = [];
  constructor(private script: LLMResponse[] = []) {}
  push(...r: LLMResponse[]) {
    this.script.push(...r);
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("ScriptedLLM: no more responses");
    return next;
  }
}

export const text = (t: string): LLMResponse => ({
  content: [{ type: "text", text: t, citations: null } as ContentBlock],
  stopReason: "end_turn",
  model: "test",
});

export const toolUse = (name: string, input: unknown, id = `tu_${name}`): LLMResponse => ({
  content: [{ type: "tool_use", id, name, input } as ContentBlock],
  stopReason: "tool_use",
  model: "test",
});

export function realRuntime(llm: LLMClient = new ScriptedLLM()) {
  const store = new MemoryStore();
  const runtime = createSahayaRuntime({ store, llm, integrationMode: () => "sandbox" });
  return { store, runtime, llm };
}

/**
 * Minimal test agents (with working handlers) that reuse the real agent IDs, so runtime,
 * bus and policy behavior can be exercised before the real tool handlers land.
 */
export function testRuntime(llm: LLMClient = new ScriptedLLM()) {
  const store = new MemoryStore();
  const runtime = new AgentRuntime({ store, llm, integrationMode: (id) => (id === "telephony" ? "unavailable" : "sandbox") });
  const calls: Record<string, unknown[]> = {};
  const received: AgentEvent[] = [];

  const def = (id: AgentId, extra: Partial<AgentDefinition>): AgentDefinition => ({
    id,
    displayName: id,
    tagline: "",
    welcome: "",
    systemPrompt: `You are the ${id} test agent.`,
    effort: "low",
    memoryNamespaces: [`${id}.data`],
    tools: [],
    events: { outbound: [], inbound: [] },
    policy: DEFAULT_POLICY,
    workflows: [],
    suggestedCommands: [],
    jobKinds: [],
    ...extra,
  });

  const assistPayload = z.object({ need: z.string(), summary: z.string() });

  const careDef = def("care", {
    tools: [
      defineTool({
        name: "saveNote",
        owner: "care",
        description: "save a note",
        input: z.object({ note: z.string().min(1) }),
        risk: "write",
        handler: async (i, tc) => {
          (calls.saveNote ??= []).push(i);
          await tc.store.putMemory({
            id: `m_${i.note}`, userId: tc.ctx.userId, namespace: "care.data", key: i.note,
            value: i.note, text: i.note, createdAt: tc.now(), updatedAt: tc.now(),
          });
          return { saved: i.note };
        },
      }),
      defineTool({
        name: "placeOrder",
        owner: "care",
        description: "place an order",
        input: z.object({ cartId: z.string(), totalCents: z.number().int() }),
        risk: "sensitive",
        summarize: (i) => `Order ${i.cartId} for ${i.totalCents}`,
        handler: async (i) => {
          (calls.placeOrder ??= []).push(i);
          return { orderId: `ord_${i.cartId}` };
        },
      }),
      defineTool({
        name: "flaky",
        owner: "care",
        description: "fails once then succeeds",
        input: z.object({}),
        risk: "read",
        maxRetries: 2,
        handler: async () => {
          const n = ((calls.flaky ??= []).push(1));
          if (n < 2) {
            const { AgentError } = await import("@/agents/base/errors");
            throw new AgentError("TOOL_FAILED", "transient", undefined, true);
          }
          return { ok: true };
        },
      }),
      defineTool({
        name: "askGuardianForHelp",
        owner: "care",
        description: "cross-agent",
        input: z.object({ need: z.string(), summary: z.string(), extra: z.string().optional() }),
        risk: "write",
        handler: async (i, tc) => {
          const payload: Record<string, unknown> = { need: i.need, summary: i.summary };
          if (i.extra) payload.extra = i.extra;
          return tc.emit("guardian", "assist", payload);
        },
      }),
    ],
    events: { outbound: [{ type: "assist", target: "guardian", description: "", payload: assistPayload }], inbound: [] },
  });

  const guardianDef = def("guardian", {
    tools: [
      defineTool({
        name: "callForHelp",
        owner: "guardian",
        description: "needs telephony",
        input: z.object({ who: z.string() }),
        risk: "sensitive",
        integrations: ["telephony"],
        handler: async () => ({ called: true }),
      }),
    ],
    events: { outbound: [], inbound: [{ type: "assist", from: ["care"], description: "", payload: assistPayload }] },
  });

  class TestAgent extends BaseAgent {
    protected override async onEvent(event: AgentEvent) {
      received.push(event);
      const task = await this.planTask({ userId: event.userId, actor: { id: "sys", role: "system" } }, "noop", "event");
      return { taskId: task.id };
    }
  }
  const withNoop = (d: AgentDefinition): AgentDefinition => ({
    ...d,
    workflows: [{ id: "noop", title: "noop", description: "", steps: [{ description: "noop" }] }],
  });

  runtime.register(withNoop(careDef), (deps: AgentDeps) => new TestAgent(withNoop(careDef), deps));
  runtime.register(withNoop(guardianDef), (deps: AgentDeps) => new TestAgent(withNoop(guardianDef), deps));
  runtime.register(def("wellness", {}), (deps) => new TestAgent(def("wellness", {}), deps));
  runtime.register(def("finance", {}), (deps) => new TestAgent(def("finance", {}), deps));
  return { store, runtime, calls, received };
}
