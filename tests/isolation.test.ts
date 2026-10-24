import { describe, expect, it } from "vitest";
import { createInMemoryDataLayer } from "@/agents/base/memoryStore";
import { createAgent } from "@/agents/registry";
import { PermissionError } from "@/agents/base/ScopedMemory";

const USER = "user-iso";

function freshAgents() {
  const data = createInMemoryDataLayer();
  return {
    data,
    guardian: createAgent("guardian", { data, userId: USER }),
    care: createAgent("care", { data, userId: USER }),
    wellness: createAgent("wellness", { data, userId: USER }),
    finance: createAgent("finance", { data, userId: USER }),
  };
}

describe("agent memory isolation (prompt §4)", () => {
  it("an agent cannot see another agent's namespaced memory", async () => {
    const { guardian, care } = freshAgents();
    await guardian.memory.save("incidents", { summary: "secret incident", severity: "high" });

    const guardianView = await guardian.memory.list("incidents");
    const careView = await care.memory.list("incidents");

    expect(guardianView).toHaveLength(1);
    expect(careView).toHaveLength(0);
  });

  it("agents writing the same collection name stay separate", async () => {
    const { care, finance } = freshAgents();
    await care.memory.save("records", { kind: "grocery" });
    await finance.memory.save("records", { kind: "bill" });

    const careRecords = await care.memory.list("records");
    const financeRecords = await finance.memory.list("records");

    expect(careRecords).toHaveLength(1);
    expect(financeRecords).toHaveLength(1);
    expect(careRecords[0].data.kind).toBe("grocery");
    expect(financeRecords[0].data.kind).toBe("bill");
  });

  it("get() refuses to return another namespace's record even by id", async () => {
    const { guardian, care } = freshAgents();
    const rec = await guardian.memory.save("incidents", { summary: "x" });
    // Care holds the id but must not be able to read it.
    const leaked = await care.memory.get(rec.id);
    expect(leaked).toBeNull();
  });

  it("shared memory honors per-agent permissions", async () => {
    const { care, finance, guardian } = freshAgents();
    // Care may write shared; Finance may not.
    await expect(care.memory.writeShared("groceryPreferences", { usual: ["milk"] })).resolves.toBeTruthy();
    await expect(finance.memory.writeShared("x", { a: 1 })).rejects.toBeInstanceOf(PermissionError);
    // Guardian may read shared.
    const shared = await guardian.memory.readShared("groceryPreferences");
    expect(shared.length).toBeGreaterThanOrEqual(1);
  });

  it("each agent exposes its own distinct tool registry", () => {
    const { guardian, care, wellness, finance } = freshAgents();
    const names = (a: typeof guardian) => a.tools.map((t) => t.name).sort();
    expect(names(guardian)).toContain("requestEmergencyAssistance");
    expect(names(care)).toContain("createShoppingCart");
    expect(names(wellness)).toContain("saveWellnessMemory");
    expect(names(finance)).toContain("analyzeMedicalBill");
    // No cross-contamination.
    expect(names(guardian)).not.toContain("createShoppingCart");
    expect(names(finance)).not.toContain("requestEmergencyAssistance");
  });
});
