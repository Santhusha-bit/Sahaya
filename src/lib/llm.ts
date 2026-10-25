import Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, isClaudeLive } from "./env";

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

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export function llmAvailable(): boolean {
  return isClaudeLive();
}

// Latency controls. Defaults favor a fast, responsive UX (short replies, no
// extended thinking) because security is enforced deterministically in code, not
// by the model. Set AGENT_THINKING=adaptive to re-enable thinking (slower).
const MAX_TOKENS = Math.max(256, Number(process.env.AGENT_MAX_TOKENS ?? 800));
const THINKING_ENABLED = process.env.AGENT_THINKING === "adaptive";

/**
 * Run a single Claude turn (used inside the agent runtime's tool loop). Tuned for
 * low latency: a fast model, a tight output budget, and thinking off by default.
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
    ...(THINKING_ENABLED
      ? { thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam }
      : {}),
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
    ...(THINKING_ENABLED
      ? { thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam }
      : {}),
    tools: opts.tools.length ? (opts.tools as unknown as Anthropic.Tool[]) : undefined,
    messages: opts.messages,
  });
  stream.on("text", (delta) => opts.onText(delta));
  const response = await stream.finalMessage();
  return toTurn(response);
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
