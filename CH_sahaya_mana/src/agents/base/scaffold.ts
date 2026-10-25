import { AgentError } from "./errors";

/**
 * Handler placeholder for tools whose domain logic lands in a later milestone.
 * Fails loudly and honestly instead of returning fabricated data.
 */
export function notYetImplemented(tool: string, milestone: string) {
  return async (): Promise<never> => {
    throw new AgentError("TOOL_FAILED", `${tool} is not implemented yet (scheduled for ${milestone})`);
  };
}
