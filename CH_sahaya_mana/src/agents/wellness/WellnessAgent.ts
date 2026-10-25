import { BaseAgent, type AgentDefinition, type AgentDeps } from "../base/BaseAgent";
import { DEFAULT_POLICY } from "../base/policy";
import { EVENT_TYPES, mealAssistancePayload, safetyConcernPayload } from "../contracts";
import { WELLNESS_PROMPT } from "./wellnessPrompt";
import { WELLNESS_NAMESPACES, wellnessTools } from "./wellnessTools";

export const wellnessDefinition: AgentDefinition = {
  id: "wellness",
  displayName: "Wellness",
  tagline: "Talk about your day and stay connected.",
  welcome: "Hi there, I'm Wellness. How are you feeling today? I'd love to hear about your day.",
  systemPrompt: WELLNESS_PROMPT,
  effort: "medium",
  memoryNamespaces: WELLNESS_NAMESPACES,
  tools: wellnessTools,
  policy: DEFAULT_POLICY,
  events: {
    outbound: [
      {
        type: EVENT_TYPES.safetyConcern,
        target: "guardian",
        description: "Escalate an urgent safety concern to Guardian",
        payload: safetyConcernPayload,
      },
      {
        type: EVENT_TYPES.mealAssistance,
        target: "care",
        description: "Ask Care for meal or grocery help",
        payload: mealAssistancePayload,
      },
    ],
    inbound: [],
  },
  workflows: [
    {
      id: "daily_check_in",
      title: "Daily check-in",
      description: "Conversation → observations → saved memory → summary",
      steps: [
        { description: "Start the check-in", toolName: "startConversationalCheckIn" },
        { description: "Extract observations", toolName: "extractWellnessObservations" },
        { description: "Save observations", toolName: "saveWellnessMemory" },
        { description: "Summarize the week", toolName: "generateWellnessSummary" },
      ],
    },
  ],
  suggestedCommands: [
    "I didn't sleep well last night",
    "I've been feeling a bit lonely",
    "How has my week been?",
    "I'd like to call my son this weekend",
  ],
  jobKinds: ["daily_check_in", "follow_up"],
};

export class WellnessAgent extends BaseAgent {
  constructor(deps: AgentDeps) {
    super(wellnessDefinition, deps);
  }
  // Job handlers land in M3.
}
