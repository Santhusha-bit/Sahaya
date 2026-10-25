import { AgentRuntime, type RuntimeOptions } from "./base/AgentRuntime";
import type { AgentDefinition } from "./base/BaseAgent";
import type { AgentId } from "./base/types";
import { CareAgent, careDefinition } from "./care/CareAgent";
import { FinanceAgent, financeDefinition } from "./finance/FinanceAgent";
import { GuardianAgent, guardianDefinition } from "./guardian/GuardianAgent";
import { WellnessAgent, wellnessDefinition } from "./wellness/WellnessAgent";

export const AGENT_DEFINITIONS: Record<AgentId, AgentDefinition> = {
  guardian: guardianDefinition,
  care: careDefinition,
  wellness: wellnessDefinition,
  finance: financeDefinition,
};

/** Builds the runtime with four independently-instantiated agents. */
export function createSahayaRuntime(opts: RuntimeOptions): AgentRuntime {
  const runtime = new AgentRuntime(opts);
  runtime.register(guardianDefinition, (deps) => new GuardianAgent(deps));
  runtime.register(careDefinition, (deps) => new CareAgent(deps));
  runtime.register(wellnessDefinition, (deps) => new WellnessAgent(deps));
  runtime.register(financeDefinition, (deps) => new FinanceAgent(deps));
  return runtime;
}
