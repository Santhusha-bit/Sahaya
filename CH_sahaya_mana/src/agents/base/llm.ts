import Anthropic from "@anthropic-ai/sdk";
import { AgentError } from "./errors";
import type { ContentBlock, MessageParam } from "./types";

export const CLAUDE_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMRequest {
  system: string;
  tools: Anthropic.Beta.Messages.BetaTool[];
  messages: MessageParam[];
  effort: Effort;
  /** "none" forces a text-only answer (used when the tool-iteration cap is reached). */
  toolChoice?: "auto" | "none";
}

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: string | null;
  model: string;
}

export interface LLMClient {
  readonly available: boolean;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/** Claude via the official SDK. Each agent calls it with its own system prompt and tool set. */
export class ClaudeLLMClient implements LLMClient {
  readonly available = true;
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    try {
      const res = await this.client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: req.effort },
        // Server-side fallback: on a safety-classifier refusal, the API re-runs on a suitable model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The system prompt and tools are stable per agent, so they cache well.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        tool_choice: req.tools.length ? { type: req.toolChoice ?? "auto" } : undefined,
        messages: req.messages,
      });
      return { content: res.content, stopReason: res.stop_reason, model: res.model };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new AgentError("INTEGRATION_UNAVAILABLE", "Claude rejected the API key", undefined, false);
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new AgentError("TOOL_FAILED", "Claude is rate limited; try again shortly", undefined, true);
      }
      if (err instanceof Anthropic.BadRequestError) {
        throw new AgentError("TOOL_FAILED", `Claude rejected the request: ${err.message}`, undefined, false);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new AgentError("TOOL_FAILED", "Could not reach Claude", undefined, true);
      }
      if (err instanceof Anthropic.APIError) {
        throw new AgentError("TOOL_FAILED", `Claude error: ${err.message}`, undefined, true);
      }
      throw err;
    }
  }
}

/** Used when no Claude credentials are configured. Never fabricates responses. */
export class UnavailableLLMClient implements LLMClient {
  readonly available = false;
  async complete(): Promise<LLMResponse> {
    throw new AgentError("INTEGRATION_UNAVAILABLE", "Claude is not configured (set ANTHROPIC_API_KEY)");
  }
}

export function createLLMClient(env: Record<string, string | undefined> = process.env): LLMClient {
  return env.ANTHROPIC_API_KEY ? new ClaudeLLMClient(env.ANTHROPIC_API_KEY) : new UnavailableLLMClient();
}
