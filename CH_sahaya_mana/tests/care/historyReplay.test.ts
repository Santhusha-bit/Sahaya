
import { describe, expect, it } from "vitest";
import type { LLMResponse } from "@/agents/base/llm";
import type { AgentContext, ContentBlock } from "@/agents/base/types";
import { ScriptedLLM, realRuntime, text } from "../helpers";

const ana: AgentContext = { userId: "user_ana", actor: { id: "user_ana", role: "older_adult" } };
const withThinking = (t: string): LLMResponse => ({
  content: [{ type: "thinking", thinking: "private reasoning", signature: "sig-bound-to-prefix" } as unknown as ContentBlock, { type: "text", text: t, citations: null } as ContentBlock],
  stopReason: "end_turn",
  model: "test",
});

describe("history replay", () => {
  it("drops signed thinking blocks from completed earlier turns (their signatures break when the window slides)", async () => {
    const llm = new ScriptedLLM();
    const { runtime } = realRuntime(llm);
    const care = runtime.get("care");
    await runtime.initializeAll(ana);
    llm.push(withThinking("Hello!"));
    await care.processMessage(ana, "Hi there");
    llm.push(text("Sure."));
    await care.processMessage(ana, "Can you help me?");
    const replayed = llm.requests.at(-1)!.messages;
    expect(JSON.stringify(replayed)).not.toContain("thinking");
    expect(JSON.stringify(replayed)).toContain("Hello!"); // the visible reply is kept
    // Stored history still has the original blocks (nothing rewritten).
    const stored = await care.listConversation(ana);
    expect(stored.some((m) => m.role === "assistant" && m.text.includes("Hello!"))).toBe(true);
  });
});
