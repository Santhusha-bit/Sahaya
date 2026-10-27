import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSahayaRuntime } from "@/agents";
import type { CareAgent } from "@/agents/care/CareAgent";
import { careServices } from "@/agents/care/careTools";
import { FileStore } from "@/lib/storage/FileStore";
import { ScriptedLLM, text, toolUse } from "../helpers";

const ana = { userId: "user_ana", actor: { id: "user_ana", role: "older_adult" as const } };

function boot(path: string, llm = new ScriptedLLM()) {
  const store = new FileStore(path);
  const runtime = createSahayaRuntime({ store, llm, now: () => 1_800_000_000_000, integrationMode: () => "sandbox" });
  return { store, runtime, llm, care: runtime.get("care") as CareAgent };
}

describe("durable local store", () => {
  it("keeps what Care learned across a restart, in an owner-only file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sahaya-")), ".data", "store.json");
    const a = boot(path);
    a.llm.push(toolUse("rememberAboutUser", { kind: "address_as", value: "Annie", userStatement: "call me Annie" }), text("Okay, Annie."));
    await a.care.processMessage(ana, "Please call me Annie");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("Annie");

    // "Restart": a new process-level store reading the same file.
    const b = boot(path);
    expect(await b.care.displayName(ana)).toBe("Annie");
    const svc = careServices({ store: (b.care as unknown as { store: Parameters<typeof careServices>[0]["store"] }).store, now: () => 1, integrationMode: () => "sandbox", emit: async () => { throw new Error("unused"); }, ctx: {} });
    const facts = await svc.memory.list(ana.userId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "address_as", value: "Annie", status: "reported" });
    expect((await b.care.listConversation(ana)).map((m) => m.text)).toContain("Please call me Annie");
  });

  it("deleting a memory removes it from the file too", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "sahaya-")), "store.json");
    const a = boot(path);
    a.llm.push(toolUse("rememberAboutUser", { kind: "grocery_preference", value: "low sodium", userStatement: "low sodium" }), text("Noted."));
    await a.care.processMessage(ana, "I like low sodium food");
    const [fact] = await a.care.listMemories(ana);
    await a.care.deleteMemory(ana, fact.id);
    const b = boot(path);
    expect(await b.care.listMemories(ana)).toEqual([]);
    // The memory record itself is gone from the file (the chat transcript is separate history).
    expect(readFileSync(path, "utf8")).not.toContain(`care.memory|${fact.id}`);
  });
});
