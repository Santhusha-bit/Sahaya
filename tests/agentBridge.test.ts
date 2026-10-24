import { describe, expect, it } from "vitest";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import {
  AssistanceRequestSchema,
  SandboxBridge,
  requestAssistance,
  type AssistanceRequest,
} from "@/integrations/fetchai";

const USER = "user-bridge";

function validRequest(over: Partial<AssistanceRequest> = {}): AssistanceRequest {
  return {
    request_id: "req-1",
    from_agent: "wellness",
    to_agent: "guardian",
    user_id: USER,
    need: "I don't have anyone to help me get groceries",
    consent_ref: "consent-1",
    urgency: "soon",
    ...over,
  };
}

describe("agent-to-agent bridge (Track 5)", () => {
  it("validates the typed message schema and rejects malformed requests", async () => {
    const bridge = new SandboxBridge(createInMemoryDataLayer(), DEFAULT_CONSENT);
    const res = await bridge.send({ request_id: "bad-1", need: "help" }); // missing required fields
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/invalid_request_schema/);
    expect(res.request_id).toBe("bad-1");
  });

  it("rejects a request that carries no consent reference", async () => {
    const bridge = new SandboxBridge(createInMemoryDataLayer(), DEFAULT_CONSENT);
    const res = await bridge.send(validRequest({ consent_ref: "" }));
    expect(res.status).toBe("rejected");
  });

  it("rejects when the user has not consented to the workflow", async () => {
    const bridge = new SandboxBridge(createInMemoryDataLayer(), { ...DEFAULT_CONSENT, wellnessToGuardianAssist: false });
    const res = await bridge.send(validRequest());
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/consent/i);
  });

  it("accepts a consented request and the response matches the request id", async () => {
    const data = createInMemoryDataLayer();
    const bridge = new SandboxBridge(data, DEFAULT_CONSENT);
    const res = await bridge.send(validRequest({ request_id: "req-xyz" }));
    expect(res.status).toBe("accepted");
    expect(res.request_id).toBe("req-xyz");
    expect(res.task_id).toBeTruthy();

    // Guardian actually coordinated: a task exists under its own namespace.
    const guardian = createAgent("guardian", { data, userId: USER });
    const tasks = await guardian.taskService.list();
    expect(tasks.some((t) => t.correlationId === "req-xyz")).toBe(true);
  });

  it("only the declared, narrow payload crosses the bridge", async () => {
    const data = createInMemoryDataLayer();
    const bridge = new SandboxBridge(data, DEFAULT_CONSENT);
    await bridge.send(validRequest({ request_id: "req-narrow" }));
    const events = await data.events.list({ userId: USER, limit: 10 });
    const evt = events.find((e) => e.correlationId === "req-narrow");
    expect(evt).toBeTruthy();
    expect(evt!.type).toBe("assistance.request");
    expect(Object.keys(evt!.payload).sort()).toEqual(["consentRef", "need", "urgency"]);
    expect(evt!.payload).not.toHaveProperty("user_id");
  });

  it("the Wellness orchestration records consent and reports back to the person", async () => {
    const data = createInMemoryDataLayer();
    const bridge = new SandboxBridge(data, DEFAULT_CONSENT);
    const { request, response, userMessage } = await requestAssistance(bridge, {
      userId: USER,
      need: "I don't have anyone to help me get groceries",
    });
    expect(AssistanceRequestSchema.safeParse(request).success).toBe(true);
    expect(response.request_id).toBe(request.request_id);
    expect(response.status).toBe("accepted");
    expect(userMessage.toLowerCase()).toContain("guardian");
  });

  it("the Wellness planner routes 'no one to help' to the assistance tool", async () => {
    const data = createInMemoryDataLayer();
    const wellness = createAgent("wellness", { data, userId: USER });
    await wellness.initialize();
    const reply = await wellness.processMessage("I don't have anyone to help me get groceries");
    const call = reply.toolCalls.find((c) => c.toolName === "requestHumanAssistance");
    expect(call).toBeTruthy();
    expect(call!.status).toBe("success");
  });
});
