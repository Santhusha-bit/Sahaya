import { BaseAgent, type AgentDefinition, type AgentDeps } from "../base/BaseAgent";
import { DEFAULT_POLICY } from "../base/policy";
import { EVENT_TYPES, paymentReviewPayload, suspiciousChargePayload } from "../contracts";
import { FINANCE_PROMPT } from "./financePrompt";
import { FINANCE_NAMESPACES, financeTools } from "./financeTools";

export const financeDefinition: AgentDefinition = {
  id: "finance",
  displayName: "Finance",
  tagline: "Understand your bills and manage your finances.",
  welcome: "Hello, I'm Finance. Got a confusing bill or a charge you don't recognize? Tell me about it and I'll help you make sense of it.",
  systemPrompt: FINANCE_PROMPT,
  effort: "high",
  memoryNamespaces: FINANCE_NAMESPACES,
  tools: financeTools,
  // Money movement: approvals expire after 6h instead of the 24h default.
  policy: { ...DEFAULT_POLICY, approvalTtlMs: 6 * 60 * 60 * 1000 },
  events: {
    outbound: [
      {
        type: EVENT_TYPES.suspiciousCharge,
        target: "guardian",
        description: "Flag a possibly fraudulent charge to Guardian",
        payload: suspiciousChargePayload,
      },
    ],
    inbound: [
      {
        type: EVENT_TYPES.paymentReview,
        from: ["care"],
        description: "Care asks Finance to review a grocery order payment",
        payload: paymentReviewPayload,
      },
    ],
  },
  workflows: [
    {
      id: "bill_review",
      title: "Review a medical bill",
      description: "Analyze → compare with insurance → draft dispute → approval",
      steps: [
        { description: "Analyze the bill", toolName: "analyzeMedicalBill" },
        { description: "Compare with the insurance EOB", toolName: "compareInsuranceDocuments" },
        { description: "Prepare a dispute if needed", toolName: "prepareDispute" },
      ],
    },
  ],
  suggestedCommands: [
    "Help me understand this hospital bill",
    "Am I paying for any subscriptions?",
    "Is there any help paying for my prescriptions?",
    "What would assisted living cost over two years?",
  ],
  jobKinds: ["recurring_charge_scan"],
};

export class FinanceAgent extends BaseAgent {
  constructor(deps: AgentDeps) {
    super(financeDefinition, deps);
  }
  // Inbound event and job handlers land in M3.
}
