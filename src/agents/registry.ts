import type { AgentConfig, AgentDeps, AgentTheme, BaseAgent } from "./base/BaseAgent";
import { CareAgent } from "./care/CareAgent";
import { FinanceAgent } from "./finance/FinanceAgent";
import { GuardianAgent } from "./guardian/GuardianAgent";
import type { AgentId, AgentTool } from "./base/types";
import { WellnessAgent } from "./wellness/WellnessAgent";

type AgentCtor = new (deps: AgentDeps) => BaseAgent;

const REGISTRY: Record<AgentId, AgentCtor> = {
  guardian: GuardianAgent,
  care: CareAgent,
  wellness: WellnessAgent,
  finance: FinanceAgent,
};

export function createAgent(agentId: AgentId, deps: AgentDeps): BaseAgent {
  const Ctor = REGISTRY[agentId];
  if (!Ctor) throw new Error(`Unknown agent: ${agentId}`);
  return new Ctor(deps);
}

/** Static metadata (config + tool names) for UI, without a data layer. */
export interface AgentMeta {
  id: AgentId;
  displayName: string;
  tagline: string;
  welcome: string;
  suggestedCommands: string[];
  theme: AgentTheme;
  toolNames: string[];
}

function metaFrom(config: AgentConfig, tools: AgentTool[]): AgentMeta {
  return {
    id: config.id,
    displayName: config.displayName,
    tagline: config.tagline,
    welcome: config.welcome,
    suggestedCommands: config.suggestedCommands,
    theme: config.theme,
    toolNames: tools.map((t) => t.name),
  };
}

// Instantiate once with a throwaway deps-less view purely to read static config.
// We build lightweight instances with a null-ish data layer only to read config;
// instead, read config via prototype is awkward, so construct with a stub store.
import { createInMemoryDataLayer } from "./base/memoryStore";

let META_CACHE: Record<AgentId, AgentMeta> | null = null;

export function agentMeta(): Record<AgentId, AgentMeta> {
  if (META_CACHE) return META_CACHE;
  const data = createInMemoryDataLayer();
  const out = {} as Record<AgentId, AgentMeta>;
  for (const id of Object.keys(REGISTRY) as AgentId[]) {
    const agent = createAgent(id, { data, userId: "__meta__" });
    out[id] = metaFrom(agent.config, agent.tools);
  }
  META_CACHE = out;
  return out;
}

export { AGENT_IDS } from "./base/types";
