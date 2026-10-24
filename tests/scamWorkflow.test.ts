import { describe, expect, it } from "vitest";
import { AuditLog } from "@/agents/base/audit";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import {
  MARGARET_SCAM_MESSAGE,
  MARGARET_USER,
  seedMargaretScenario,
} from "@/agents/guardian/scamScenario";

async function seededGuardian() {
  const data = createInMemoryDataLayer();
  await seedMargaretScenario(data, MARGARET_USER);
  const guardian = createAgent("guardian", { data, userId: MARGARET_USER });
  await guardian.initialize();
  return { data, guardian };
}

describe("Guardian scam workflow — the Margaret scenario (Track 1 acceptance)", () => {
  it("produces a warning, blocks the transfer, verifies with the real Jake, stores an incident, and alerts the caregiver", async () => {
    const { data, guardian } = await seededGuardian();

    const { record, result } = await guardian.executeTool("screenInboundMessage", {
      content: MARGARET_SCAM_MESSAGE,
      channel: "phone",
      claimant: "Jake",
    });
    const d = result.data as Record<string, any>;

    // Warm warning returned.
    expect(record.status).toBe("success");
    expect(result.summary.toLowerCase()).toContain("scam");

    // Transfer blocked by the deterministic policy.
    expect(d.blocked).toBe(true);
    expect((d.blockedActions as string[]).some((r) => /gift card|irreversible|approval/i.test(r))).toBe(true);

    // Verification went to the real Jake via the trusted directory and he denied it.
    expect(d.verification.contact).toBe("Jake");
    expect(d.verification.method).toBe("callback_known_number");
    expect(d.verification.result).toBe("denied");
    expect(d.outcome).toBe("scam_confirmed");

    // Caregiver with incidents:view was alerted.
    expect(d.caregiversAlerted).toContain("Sarah");

    // Incident stored in guardian memory with the full shape.
    const incidents = await guardian.memory.list("incidents");
    const stored = incidents.find((i) => i.data.id === d.incidentId);
    expect(stored).toBeTruthy();
    expect(stored!.data).toHaveProperty("policyDecisions");
    expect(stored!.data).toHaveProperty("verification");
    expect(stored!.data).toHaveProperty("signals");
    expect(stored!.data.rawMessage).toBe(MARGARET_SCAM_MESSAGE);

    // Every step audit-logged.
    const audit = await new AuditLog(data.memory, MARGARET_USER).list();
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("scam.detect");
    expect(actions).toContain("scam.policy");
    expect(actions).toContain("scam.verify");
    expect(actions).toContain("scam.incident");
    expect(actions).toContain("caregiver.alert");
  });

  it("the full agent turn (sandbox planner) routes the message through the workflow", async () => {
    const { guardian } = await seededGuardian();
    const reply = await guardian.processMessage(MARGARET_SCAM_MESSAGE);
    const call = reply.toolCalls.find((c) => c.toolName === "screenInboundMessage");
    expect(call).toBeTruthy();
    expect(call!.status).toBe("success");
  });

  it("a caregiver without incidents:view is not alerted", async () => {
    const data = createInMemoryDataLayer();
    // Seed a caregiver lacking the permission.
    const { id, now } = await import("@/lib/id");
    await data.memory.put({
      id: id("mem"), namespace: "shared", collection: "caregivers", userId: "u2",
      data: { name: "Nosy Neighbor", permissions: [] }, createdAt: now(), updatedAt: now(),
    });
    await data.memory.put({
      id: id("mem"), namespace: "shared", collection: "trustedContacts", userId: "u2",
      data: { name: "Jake", relationship: "grandson", phone: "+1-555-0133", channel: "phone" },
      createdAt: now(), updatedAt: now(),
    });
    const guardian = createAgent("guardian", { data, userId: "u2" });
    await guardian.initialize();

    const { result } = await guardian.executeTool("screenInboundMessage", {
      content: MARGARET_SCAM_MESSAGE, channel: "phone", claimant: "Jake",
    });
    const d = result.data as Record<string, any>;
    expect(d.blocked).toBe(true);
    expect(d.caregiversAlerted).toHaveLength(0);
  });
});
