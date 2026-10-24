import { describe, expect, it } from "vitest";
import { AgentEventBus } from "@/agents/base/AgentEventBus";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";

const USER = "user-xagent";

function busWith(consent: Record<string, boolean>) {
  const data = createInMemoryDataLayer();
  return { data, bus: new AgentEventBus(data.events, consent as any) };
}

describe("cross-agent permissions & the event bus (prompt §5)", () => {
  it("allows an authorized, consented event with a valid payload", async () => {
    const { bus } = busWith({ wellnessToGuardian: true });
    const res = await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "safety.escalation",
      userId: USER,
      payload: { summary: "User sounds unsafe", severity: "high" },
    });
    expect(res.ok).toBe(true);
    expect(res.event.status).toBe("accepted");
  });

  it("blocks an event that has no authorized rule", async () => {
    const { bus } = busWith({});
    const res = await bus.publish({
      sourceAgent: "guardian",
      targetAgent: "finance",
      type: "exfiltrate.everything",
      userId: USER,
      payload: { any: "thing" },
    });
    expect(res.ok).toBe(false);
    expect(res.event.status).toBe("blocked");
  });

  it("blocks an authorized event when the user has not consented", async () => {
    const { bus } = busWith({ wellnessToGuardian: false });
    const res = await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "safety.escalation",
      userId: USER,
      payload: { summary: "concern", severity: "high" },
    });
    expect(res.ok).toBe(false);
    expect(res.event.status).toBe("blocked");
    expect(res.reason).toMatch(/consent/i);
  });

  it("rejects a payload that does not match the rule's schema", async () => {
    const { bus } = busWith({ wellnessToGuardian: true });
    const res = await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "safety.escalation",
      userId: USER,
      payload: { severity: "not-a-valid-severity" }, // missing summary, bad enum
    });
    expect(res.ok).toBe(false);
    expect(res.event.status).toBe("rejected");
  });

  it("never transmits whole conversations — only the permitted payload fields cross", async () => {
    const { bus } = busWith({ wellnessToGuardian: true });
    const res = await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "safety.escalation",
      userId: USER,
      payload: {
        summary: "concern",
        severity: "high",
        fullConversation: "x".repeat(5000), // must be stripped
        privateNotes: "should not cross",
      },
    });
    expect(res.ok).toBe(true);
    expect(res.event.payload).toHaveProperty("summary");
    expect(res.event.payload).not.toHaveProperty("fullConversation");
    expect(res.event.payload).not.toHaveProperty("privateNotes");
  });

  it("only the target agent receives the event in its inbox", async () => {
    const { bus } = busWith({ wellnessToGuardian: true });
    await bus.publish({
      sourceAgent: "wellness",
      targetAgent: "guardian",
      type: "safety.escalation",
      userId: USER,
      payload: { summary: "concern", severity: "high" },
    });
    const guardianInbox = await bus.inbox("guardian", USER);
    const careInbox = await bus.inbox("care", USER);
    expect(guardianInbox).toHaveLength(1);
    expect(careInbox).toHaveLength(0);
  });
});
