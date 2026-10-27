import { describe, expect, it } from "vitest";
import { USER, realRuntime, testRuntime, userCtx } from "./helpers";

const grant = (runtime: ReturnType<typeof testRuntime>["runtime"]) =>
  runtime.setConsent(userCtx, "care", "guardian", "assist", true);

describe("cross-agent event bus", () => {
  it("rejects events without user consent and records the rejection", async () => {
    const { runtime, store, received } = testRuntime();
    const res = await runtime.get("care").executeTool(userCtx, "askGuardianForHelp", { need: "pickup", summary: "pharmacy run" });
    expect(res).toMatchObject({ status: "error", code: "CONSENT_REQUIRED" });
    expect(received).toHaveLength(0);
    const [event] = await store.listEvents({ userId: USER });
    expect(event).toMatchObject({ status: "rejected", sourceAgent: "care", targetAgent: "guardian" });
  });

  it("delivers consented events to the target agent, which plans its own task", async () => {
    const { runtime, received } = testRuntime();
    await grant(runtime);
    const res = await runtime.get("care").executeTool(userCtx, "askGuardianForHelp", { need: "pickup", summary: "pharmacy run" });
    expect(res.status).toBe("success");
    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event).toMatchObject({
      sourceAgent: "care",
      targetAgent: "guardian",
      type: "assist",
      userId: USER,
      authorizedBy: USER,
      payload: { need: "pickup", summary: "pharmacy run" },
    });
    expect(event.correlationId).toBeTruthy();
    expect(event.timestamp).toBeGreaterThan(0);
    const output = (res as { output: { status: string; resultTaskId: string } }).output;
    expect(output.status).toBe("handled");
    // The task belongs to Guardian, not Care.
    const task = await runtime.get("guardian").getTaskStatus(userCtx, output.resultTaskId);
    expect(task.agentId).toBe("guardian");
    await expect(runtime.get("care").getTaskStatus(userCtx, output.resultTaskId)).rejects.toThrow(/another agent/);
  });

  it("revoking consent blocks further events", async () => {
    const { runtime } = testRuntime();
    await grant(runtime);
    await runtime.setConsent(userCtx, "care", "guardian", "assist", false);
    const res = await runtime.get("care").executeTool(userCtx, "askGuardianForHelp", { need: "x", summary: "y" });
    expect(res).toMatchObject({ code: "CONSENT_REQUIRED" });
  });

  it("strips nothing silently: payload fields outside the contract are rejected", async () => {
    const { runtime, received } = testRuntime();
    await grant(runtime);
    const res = await runtime.get("care").executeTool(userCtx, "askGuardianForHelp", { need: "x", summary: "y", extra: "private" });
    expect(res).toMatchObject({ status: "error", code: "EVENT_REJECTED" });
    expect(received).toHaveLength(0);
  });

  it("never lets conversation history cross agent boundaries", async () => {
    const { runtime } = testRuntime();
    await grant(runtime);
    await expect(
      runtime.bus.publish("care", "guardian", "assist", { need: "x", summary: "y", history: [] }, userCtx),
    ).rejects.toThrow(/may not cross/);
  });

  it("rejects routes that were not declared by both agents", async () => {
    const { runtime } = testRuntime();
    await expect(runtime.bus.publish("care", "wellness", "assist", { need: "x", summary: "y" }, userCtx)).rejects.toThrow(
      /no outbound contract/,
    );
    await expect(runtime.bus.publish("guardian", "care", "assist", { need: "x", summary: "y" }, userCtx)).rejects.toThrow(
      /no outbound contract/,
    );
    await expect(runtime.setConsent(userCtx, "care", "wellness", "assist", true)).rejects.toThrow(/no declared route/);
  });

  it("only the user can grant cross-agent consent", async () => {
    const { runtime } = testRuntime();
    await expect(
      runtime.setConsent({ userId: USER, actor: { id: "cg", role: "caregiver" } }, "care", "guardian", "assist", true),
    ).rejects.toThrow(/only the user/);
  });

  it("exposes the four spec'd collaboration routes for the real agents", () => {
    const { runtime } = realRuntime();
    const routes = runtime.bus.listRoutes().map((r) => `${r.source}->${r.target}:${r.type}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        "wellness->guardian:safety_concern_escalation",
        "care->guardian:physical_assistance_request",
        "care->finance:payment_review_request",
        "wellness->care:meal_assistance_request",
      ]),
    );
  });

  it("validates real payload schemas between real agents", async () => {
    const { runtime } = realRuntime();
    await runtime.setConsent(userCtx, "wellness", "guardian", "safety_concern_escalation", true);
    await expect(
      runtime.bus.publish("wellness", "guardian", "safety_concern_escalation", { severity: "catastrophic", category: "other", summary: "x", observedAt: 1 }, userCtx),
    ).rejects.toThrow(/invalid payload/);
  });
});

describe("scheduling", () => {
  it("only schedules job kinds the agent declares, and runs due jobs by owner", async () => {
    const { runtime } = realRuntime();
    const care = runtime.get("care");
    await expect(care.scheduleTask(userCtx, { kind: "daily_check_in", runAt: 0 })).rejects.toThrow(/cannot schedule/);
    const job = await care.scheduleTask(userCtx, { kind: "medication_reminder", runAt: 0, everyMs: 86_400_000 });
    expect(job.agentId).toBe("care");
    const [ran] = await runtime.runDueJobs();
    // Care now handles medication_reminder (a no-op for a user with no Care profile); the recurring job is kept.
    expect(ran).toMatchObject({ id: job.id, status: "scheduled" });
    expect(ran.lastError).toBeUndefined();
    expect(ran.lastRunAt).toBeDefined();
  });
});
