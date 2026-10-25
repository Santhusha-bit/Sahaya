import { describe, expect, it } from "vitest";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { DEFAULT_CONSENT } from "@/agents/base/policy";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getDataLayer } from "@/agents/base/dataLayer";
import { POST as guardianIntake } from "@/app/api/bridge/guardian/assistance/route";
import {
  AssistanceRequestSchema,
  FetchAIBridge,
  SandboxBridge,
  acceptAssistanceAtGuardian,
  createAssistanceBridge,
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

  it("Wellness must get the person's permission before anything reaches Guardian", async () => {
    const data = getDataLayer();
    const user = "user-bridge-approval";
    const wellness = createAgent("wellness", { data, userId: user });
    await wellness.initialize();
    const reply = await wellness.processMessage("I don't have anyone to help me get groceries");
    const call = reply.toolCalls.find((c) => c.toolName === "requestHumanAssistance");
    expect(call?.status).toBe("awaiting_approval");
    expect(reply.approvalsRequested).toHaveLength(1);

    // Nothing has crossed to Guardian yet.
    const before = await data.events.list({ userId: user, limit: 50 });
    expect(before.some((e) => e.type === "assistance.request")).toBe(false);

    // The person approves: the deferred tool runs, Guardian accepts and returns a task id.
    const approval = await wellness.approvalService.get(reply.approvalsRequested[0]);
    const { record, result } = await wellness.executeTool(approval!.toolName, approval!.input, {
      approved: true,
      correlationId: approval!.correlationId,
    });
    expect(record.status).toBe("success");
    const out = result.data as { taskId: string; status: string; backend: string; requestId: string };
    expect(out.status).toBe("accepted");
    expect(out.backend).toBe("sandbox");
    expect(out.taskId).toBeTruthy();
    expect(result.summary).toContain(out.taskId); // Wellness reports the task back to the person.

    const guardian = createAgent("guardian", { data, userId: user });
    const task = await guardian.taskService.get(out.taskId);
    expect(task?.correlationId).toBe(out.requestId);
    expect(task?.status).toBe("in_progress");
  });

  it("Care and Finance reach Guardian over the same bridge with their own identity", async () => {
    const data = createInMemoryDataLayer();
    for (const from of ["care", "finance"] as const) {
      const res = await new SandboxBridge(data, DEFAULT_CONSENT, from).send(
        validRequest({ request_id: `req-${from}`, from_agent: from as any, need: `help from ${from}` }),
      );
      expect(res.status).toBe("accepted");
      expect(res.task_id).toBeTruthy();
    }
    const guardian = createAgent("guardian", { data, userId: USER });
    const tasks = await guardian.taskService.list();
    expect(tasks.map((t) => t.correlationId).sort()).toEqual(["req-care", "req-finance"]);
  });

  it("an agent cannot send a request claiming to be another agent", async () => {
    const res = await new SandboxBridge(createInMemoryDataLayer(), DEFAULT_CONSENT, "care").send(
      validRequest({ from_agent: "wellness" }),
    );
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/invalid_request_schema/);
  });

  it("Guardian intake enforces per-workflow consent (finance)", async () => {
    const res = await acceptAssistanceAtGuardian(
      createInMemoryDataLayer(),
      validRequest({ from_agent: "finance" as any }),
      { ...DEFAULT_CONSENT, financeToGuardianAssist: false },
    );
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/consent/i);
  });

  it("live bridge posts the typed message to the agent's uAgent and parses the reply", async () => {
    let received: any = null;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received = { path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ request_id: received.body.request_id, task_id: "task_live_1", status: "accepted", reason: "", task_status: "in_progress", coordinator: "agent1qguardian" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const bridge = new FetchAIBridge(`http://127.0.0.1:${port}`, "wellness");
      const res = await bridge.send(validRequest({ request_id: "req-live" }));
      expect(received.path).toBe("/assistance");
      expect(Object.keys(received.body).sort()).toEqual(["consent_ref", "from_agent", "need", "request_id", "to_agent", "urgency", "user_id"]);
      expect(res).toMatchObject({ request_id: "req-live", task_id: "task_live_1", status: "accepted", task_status: "in_progress" });
    } finally {
      server.close();
    }
  });

  it("an unreachable live bridge is reported as a rejection, not faked", async () => {
    const res = await new FetchAIBridge("http://127.0.0.1:1", "wellness").send(validRequest({ request_id: "req-down" }));
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/fetchai_bridge_unreachable/);
  });

  it("bridge selection: per-agent uAgent URLs, sandbox otherwise", () => {
    process.env.FETCHAI_CARE_URL = "http://127.0.0.1:8022";
    try {
      expect(createAssistanceBridge({ data: createInMemoryDataLayer(), from: "care" }).backend).toBe("fetchai");
      expect(createAssistanceBridge({ data: createInMemoryDataLayer(), from: "wellness" }).backend).toBe("sandbox");
      expect(createAssistanceBridge({ data: createInMemoryDataLayer(), from: "finance" }).backend).toBe("sandbox");
    } finally {
      delete process.env.FETCHAI_CARE_URL;
    }
  });

  describe("Guardian intake endpoint (called by the Guardian uAgent)", () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      guardianIntake(
        new Request("http://localhost/api/bridge/guardian/assistance", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    it("accepts a valid bridged request and returns Guardian's task", async () => {
      const res = await post(validRequest({ request_id: "req-intake", user_id: "user-intake" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ request_id: "req-intake", status: "accepted", task_status: "in_progress" });
      expect(body.task_id).toBeTruthy();
    });

    it("rejects a malformed request", async () => {
      const res = await post({ request_id: "x", need: "help" });
      expect(res.status).toBe(400);
    });

    it("enforces the bridge token when one is configured", async () => {
      process.env.SAHAYA_BRIDGE_TOKEN = "s3cret";
      try {
        expect((await post(validRequest(), { "x-sahaya-bridge-token": "wrong" })).status).toBe(401);
        expect((await post(validRequest({ request_id: "req-tok" }), { "x-sahaya-bridge-token": "s3cret" })).status).toBe(200);
      } finally {
        delete process.env.SAHAYA_BRIDGE_TOKEN;
      }
    });

    it("refuses to run without a token in production", async () => {
      const prev = process.env.NODE_ENV;
      (process.env as Record<string, string>).NODE_ENV = "production";
      try {
        expect((await post(validRequest())).status).toBe(403);
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = prev;
      }
    });
  });
});
