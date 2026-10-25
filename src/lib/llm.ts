import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, isClaudeLive, isThinkingEnabled } from "./env";

export interface LlmToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LlmMessage = Anthropic.MessageParam;

export interface LlmTurn {
  stopReason: string | null;
  text: string;
  toolUses: LlmToolUse[];
  /** Raw assistant content, to append to the running message list. */
  assistantContent: Anthropic.ContentBlockParam[];
}

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export function llmAvailable(): boolean {
  return isClaudeLive();
}

// Adaptive thinking is ON by default: Claude decides per turn how much to reason
// before answering or calling tools (security is still enforced in code, not by
// the model). Set AGENT_THINKING=off for the fastest, thinking-free replies.
// Thinking tokens count toward max_tokens, so the budget is larger when it is on.
export const THINKING_ENABLED = isThinkingEnabled();
const MAX_TOKENS = Math.max(256, Number(process.env.AGENT_MAX_TOKENS ?? (THINKING_ENABLED ? 16000 : 800)));
const THINKING = THINKING_ENABLED
  ? { thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam }
  : {};

/** Budget for a helper call: its own answer size, plus room to think when thinking is on. */
function helperBudget(answerTokens: number): number {
  return THINKING_ENABLED ? Math.max(answerTokens, 8000) : answerTokens;
}

/**
 * Run a single Claude turn (used inside the agent runtime's tool loop). Tuned for
 * responsiveness: a cached system prompt and adaptive thinking (Claude thinks only as much as the turn needs).
 */
export async function llmTurn(opts: {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
}): Promise<LlmTurn> {
  const response = await getClient().messages.create({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    // Cache the large, stable system prompt so turns after the first (and repeat
    // requests within the cache window) skip reprocessing it — lower latency.
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ] as unknown as Anthropic.MessageCreateParams["system"],
    ...THINKING,
    tools: opts.tools.length ? (opts.tools as unknown as Anthropic.Tool[]) : undefined,
    messages: opts.messages,
  });

  return toTurn(response);
}

/**
 * Streaming variant of llmTurn. Invokes `onText` for each text delta as it
 * arrives (so the client sees words immediately), then returns the same LlmTurn
 * once the turn (including any tool_use blocks) is complete.
 */
export async function llmTurnStream(opts: {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  onText: (delta: string) => void;
}): Promise<LlmTurn> {
  const stream = getClient().messages.stream({
    model: AGENT_MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ] as unknown as Anthropic.MessageCreateParams["system"],
    ...THINKING,
    tools: opts.tools.length ? (opts.tools as unknown as Anthropic.Tool[]) : undefined,
    messages: opts.messages,
  });
  stream.on("text", (delta) => opts.onText(delta));
  const response = await stream.finalMessage();
  return toTurn(response);
}

/** One plain-text completion (no tools), for small summarization steps. */
export async function llmText(opts: { system: string; prompt: string; maxTokens?: number }): Promise<string> {
  const response = await getClient().messages.create({
    model: AGENT_MODEL,
    max_tokens: helperBudget(opts.maxTokens ?? 500),
    system: opts.system,
    ...THINKING,
    messages: [{ role: "user", content: opts.prompt }],
  });
  return response.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

/**
 * One-shot structured output: forces Claude to answer by calling `tool`, and
 * returns that tool's input (or null if the model somehow did not call it).
 */
export async function llmStructured(opts: {
  system: string;
  user: string;
  tool: LlmToolSpec;
  maxTokens?: number;
}): Promise<Record<string, unknown> | null> {
  // No thinking here: a forced tool_choice cannot be combined with thinking.
  const response = await getClient().messages.create({
    model: AGENT_MODEL,
    max_tokens: opts.maxTokens ?? 600,
    system: opts.system,
    tools: [opts.tool as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: [{ role: "user", content: opts.user }],
  });
  return toTurn(response).toolUses.find((t) => t.name === opts.tool.name)?.input ?? null;
}

/**
 * One Claude call that must answer with a single JSON object. Returns the parsed
 * object, or null on any failure (refusal, truncation, non-JSON). Callers treat
 * the result as untrusted and validate it in code before using any of it.
 */
export async function llmJson(opts: { system: string; prompt: string; maxTokens?: number }): Promise<unknown | null> {
  try {
    const response = await getClient().messages.create({
      model: AGENT_MODEL,
      max_tokens: helperBudget(opts.maxTokens ?? 4000),
      system: opts.system,
      ...THINKING,
      messages: [{ role: "user", content: opts.prompt }],
    });
    if (response.stop_reason !== "end_turn") return null;
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toTurn(response: Anthropic.Message): LlmTurn {
  let text = "";
  const toolUses: LlmToolUse[] = [];
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") {
      toolUses.push({
        id: block.id,
        name: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
      });
    }
  }
  return {
    stopReason: response.stop_reason,
    text,
    toolUses,
    assistantContent: response.content as unknown as Anthropic.ContentBlockParam[],
  };
}

export { AGENT_MODEL };
