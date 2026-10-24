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

/**
 * Run a single Claude turn (used inside the agent runtime's tool loop).
 * Uses adaptive thinking per the Opus 4.8 guidance.
 */
export async function llmTurn(opts: {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
}): Promise<LlmTurn> {
  const response = await getClient().messages.create({
    model: AGENT_MODEL,
    max_tokens: 4096,
    system: opts.system,
    // Adaptive thinking per Opus 4.8 guidance (cast: SDK types lag the API).
    thinking: { type: "adaptive" } as unknown as Anthropic.ThinkingConfigParam,
    tools: opts.tools.length ? (opts.tools as unknown as Anthropic.Tool[]) : undefined,
    messages: opts.messages,
  });

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
