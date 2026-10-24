import { BaseAgent, type AgentConfig, type SandboxPlan } from "../base/BaseAgent";
import type { AgentEvent, AgentTask, AgentTool, ToolContext } from "../base/types";
import { financePrompt } from "./financePrompt";
import { financeTools } from "./financeTools";

export class FinanceAgent extends BaseAgent {
  readonly config: AgentConfig = {
    id: "finance",
    displayName: "Finance",
    tagline: "Understand your bills and manage your finances.",
    welcome:
      "Hello, I'm Finance. I make confusing bills and statements clear, and I watch for overcharges. Want me to look at a bill or check your recurring charges?",
    systemPrompt: financePrompt,
    suggestedCommands: [
      "Help me understand this hospital bill",
      "What subscriptions am I paying for?",
      "Is my care facility invoice correct?",
      "What was my spending this month?",
    ],
    theme: {
      accent: "#d97706",
      accentSoft: "#fef3c7",
      gradient: "linear-gradient(135deg,#92400e,#d97706)",
      icon: "receipt",
    },
  };

  readonly tools: AgentTool[] = financeTools;

  protected async seed(): Promise<void> {
    const txns = [
      { merchant: "Kinline Grocery", amount: 42.3, date: "2026-10-01" },
      { merchant: "Kinline Grocery", amount: 38.9, date: "2026-10-15" },
      { merchant: "StreamTV", amount: 15.99, date: "2026-10-03" },
      { merchant: "StreamTV", amount: 15.99, date: "2026-09-03" },
      { merchant: "Pharmacy", amount: 12.0, date: "2026-10-10" },
    ];
    for (const t of txns) await this.memory.save("transactions", t, { tags: ["transaction"] });
  }

  /** Review payment requests forwarded by Care (authorized cross-agent workflow). */
  async handleEvent(event: AgentEvent): Promise<AgentTask | null> {
    if (event.type === "payment.review") {
      const amount = Number(event.payload.amount ?? 0);
      const itemCount = Number(event.payload.itemCount ?? 0);
      // Compare against grocery norm (~$60 typical).
      const flagged = amount > 120;
      await this.memory.save(
        "paymentReviews",
        { orderId: event.payload.orderId, amount, merchant: event.payload.merchant, itemCount, flagged, status: "reviewed", source: event.sourceAgent },
        { tags: ["payment-review", flagged ? "flagged" : "ok"] },
      );
      return this.taskService.create({
        title: `Payment review: $${amount.toFixed(2)} (${event.payload.merchant})`,
        description: flagged ? "Higher than usual — worth a second look." : "Within normal range.",
        steps: ["Received", "Reviewed", flagged ? "Flagged for you" : "Approved"],
        status: flagged ? "awaiting_approval" : "completed",
        result: flagged ? undefined : "Looks normal.",
        correlationId: event.correlationId,
      });
    }
    return super.handleEvent(event);
  }

  protected async sandboxPlan(message: string, _ctx: ToolContext): Promise<SandboxPlan> {
    const m = message.toLowerCase();
    if (/subscription|recurring|auto.?pay|paying for/.test(m)) {
      return { reply: "Let me scan your charges for recurring payments.", toolCalls: [{ name: "detectRecurringCharges", input: {} }] };
    }
    if (/spend|spending|transactions|this month/.test(m)) {
      return { reply: "Here's a look at your recent authorized spending.", toolCalls: [{ name: "analyzeAuthorizedTransactions", input: { days: 30 } }] };
    }
    if (/facility|care home|nursing/.test(m)) {
      return {
        reply: "I'll check that invoice against the agreed rate.",
        toolCalls: [{ name: "auditCareFacilityInvoice", input: { facility: "Care facility", agreedMonthly: 4500, invoiceTotal: 4850, extras: [{ description: "Laundry", amount: 120 }] } }],
      };
    }
    if (/bill|hospital|charge|invoice|medical/.test(m)) {
      return {
        reply: "Let's break this bill down line by line.",
        toolCalls: [
          {
            name: "analyzeMedicalBill",
            input: { provider: "Hospital", lineItems: [{ description: "Office visit", amount: 180 }, { description: "Lab work", amount: 95 }, { description: "Office visit", amount: 180 }] },
          },
        ],
      };
    }
    if (/benefit|assistance|qualify|help paying/.test(m)) {
      return { reply: "There may be programs that can help.", toolCalls: [{ name: "searchBenefits", input: { topic: message } }] };
    }
    return {
      reply:
        "I can explain bills, audit invoices, find subscriptions, and review spending. What would you like me to look at? (Sandbox mode: add an ANTHROPIC_API_KEY for full conversation.)",
    };
  }
}
