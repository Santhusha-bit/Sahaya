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
      accent: "#5a6acf",
      accentInk: "#3b449c",
      accentSoft: "#eceefb",
      gradient: "linear-gradient(135deg,#4a59bc,#5a6acf)",
      icon: "receipt",
    },
  };

  readonly tools: AgentTool[] = financeTools;

  protected async seed(): Promise<void> {
    const txns = [
      { merchant: "Sahaya Grocery", amount: 42.3, date: "2026-10-01" },
      { merchant: "Sahaya Grocery", amount: 38.9, date: "2026-10-15" },
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
    if (event.type === "x402.receipt") {
      const amount = Number(event.payload.amountUsd ?? 0);
      await this.memory.save(
        "paidServiceReceipts",
        { ...event.payload, source: event.sourceAgent, status: "recorded" },
        { tags: ["x402", String(event.payload.settlement ?? "")] },
      );
      return this.taskService.create({
        title: `Paid data service: $${amount.toFixed(2)} (${event.payload.service})`,
        description: `Small x402 test payment by Care, authorized by ${event.payload.authorizedBy}. Settlement: ${event.payload.settlement}.`,
        steps: ["Received", "Recorded"],
        status: "completed",
        result: "Recorded in paid-service receipts.",
        correlationId: event.correlationId,
      });
    }
    return super.handleEvent(event);
  }

  protected async sandboxPlan(message: string, _ctx: ToolContext): Promise<SandboxPlan> {
    const m = message.toLowerCase();
    if (/report (spending|budget)|paid reports?|x402/.test(m)) {
      return { reply: "Here's what I've spent on paid reports and the limits.", toolCalls: [{ name: "getFinancialReportSpending", input: {} }] };
    }
    if (/benchmark|fair price|typical (cost|price)|financial report|buy (a|the) report/.test(m)) {
      const region = m.match(/\b(west|northeast|midwest|south)\b/)?.[1] ?? "national";
      if (/drug|medication|prescription|pharmacy/.test(m)) {
        const drug = m.match(/\b(lisinopril|metformin|atorvastatin|amlodipine|levothyroxine|omeprazole)\b/)?.[1];
        const paid = m.match(/\$(\d+(?:\.\d+)?)/)?.[1];
        return {
          reply: "I can get a drug-price benchmark report. Let me check the price first.",
          toolCalls: [{ name: "requestFinancialReport", input: { report: "drug-price-benchmarks", region, context: { drug, pricePaid: paid ? Number(paid) : undefined } } }],
        };
      }
      if (/bill|hospital|medical|doctor|lab/.test(m)) {
        return {
          reply: "I can get a medical-billing benchmark report. Let me check the price first.",
          toolCalls: [{ name: "requestFinancialReport", input: { report: "medical-billing-benchmarks", region, context: { lineItems: [{ description: "Office visit", amount: 180 }, { description: "Lab work", amount: 95 }, { description: "Office visit", amount: 180 }] } } }],
        };
      }
      return {
        reply: "I can get a care-facility cost benchmark report. Let me check the price first.",
        toolCalls: [{ name: "requestFinancialReport", input: { report: "care-facility-costs", region, context: { monthlyCost: 4500, extras: [{ description: "Laundry", amount: 120 }] } } }],
      };
    }
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
    if (/no one to help|nobody to help|can'?t do this alone|need someone|help me (file|dispute|enroll)|sit with me/.test(m)) {
      return {
        reply: "You don't have to handle this alone. Let me ask Guardian to arrange a person to help you.",
        toolCalls: [{ name: "requestAssistanceCoordination", input: { need: message.slice(0, 280), urgency: "soon" } }],
      };
    }
    if (/benefit|assistance|qualify|help paying/.test(m)) {
      return { reply: "There may be programs that can help.", toolCalls: [{ name: "searchBenefits", input: { topic: message } }] };
    }
    if (/who are you acting|signed in|logged in|my account|who am i/.test(m)) {
      return { reply: "Let me confirm who I'm acting for.", toolCalls: [{ name: "checkAuthStatus", input: {} }] };
    }
    // Voice-friendly fallback: short, spoken sentences (no lists/markdown) so the
    // Cartesia / browser synthesizer reads it naturally. Voice and text both land
    // here via processVoiceInput -> processMessage; keeping replies speakable means
    // the sandbox path works the same in voice mode.
    return {
      reply:
        "I can explain a bill, check your care-facility invoice, find subscriptions you're paying for, or review your recent spending. Just tell me what you'd like me to look at. (Sandbox mode: add an ANTHROPIC_API_KEY for full conversation.)",
    };
  }
}
