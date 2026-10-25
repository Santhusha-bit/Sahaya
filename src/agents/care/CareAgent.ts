import { BaseAgent, type AgentConfig, type AgentReply, type SandboxPlan } from "../base/BaseAgent";
import type { AgentEvent, AgentTask, AgentTool, ToolContext } from "../base/types";
import { synthesizeSpeech } from "@/integrations/cartesia";
import { carePrompt } from "./carePrompt";
import { careTools } from "./careTools";

export class CareAgent extends BaseAgent {
  readonly config: AgentConfig = {
    id: "care",
    displayName: "Care",
    tagline: "Manage medications, groceries, and everyday care.",
    welcome:
      "Hello, I'm Care. I help with your medications, groceries, and meals. Want to check what medicine is due, or order your usual groceries?",
    systemPrompt: carePrompt,
    suggestedCommands: [
      "What medications are due today?",
      "I took my morning blood pressure pill",
      "I need my usual groceries delivered tomorrow",
      "Is my usual milk a good price right now?",
      "Suggest a few easy dinners",
    ],
    theme: {
      accent: "#4779b8",
      accentInk: "#2f5586",
      accentSoft: "#e8f0fa",
      gradient: "linear-gradient(135deg,#3a6aa6,#4779b8)",
      icon: "heart",
    },
  };

  readonly tools: AgentTool[] = careTools;

  /**
   * Cartesia voice (landing-page service map: Cartesia for voice). Synthesize a
   * spoken version of a Care reply so the voice UI can play Care's own voice.
   * Honest live/sandbox: returns Cartesia MP3 bytes only when CARTESIA_API_KEY is
   * set; otherwise null so the client falls back to browser SpeechSynthesis. This
   * lets a voice route turn processVoiceInput()'s reply into audible speech.
   */
  async speakReply(reply: Pick<AgentReply, "text">, voiceId?: string): Promise<{ audio: ArrayBuffer; contentType: string } | null> {
    if (!reply.text.trim()) return null;
    return synthesizeSpeech(reply.text, voiceId);
  }

  protected async seed(): Promise<void> {
    await this.memory.save("medications", { name: "Lisinopril", dose: "10mg", time: "08:00" });
    await this.memory.save("medications", { name: "Metformin", dose: "500mg", time: "18:00" });
    await this.memory.save("pantry", { item: "oats" }, { tags: ["pantry"] });
    await this.memory.save("pantry", { item: "bananas" }, { tags: ["pantry"] });
    // A couple of usual-order items live in shared household prefs (Care may write shared).
    await this.memory.writeShared("groceryPreferences", { usual: ["milk", "bread", "eggs", "bananas", "oats"] });
  }

  async handleEvent(event: AgentEvent): Promise<AgentTask | null> {
    if (event.type === "care.assist") {
      const kind = String(event.payload.kind ?? "meal");
      const note = String(event.payload.note ?? "");
      if (kind === "grocery") {
        const prefs = await this.memory.readShared("groceryPreferences");
        const usual = (prefs[0]?.data.usual as string[]) ?? ["milk", "bread", "eggs"];
        await this.memory.save("groceryLists", { items: usual, status: "draft", source: "wellness" }, { tags: ["grocery"] });
      } else {
        await this.memory.save("mealRequests", { note, status: "open", source: "wellness" });
      }
      return this.taskService.create({
        title: kind === "grocery" ? "Prep groceries (requested by Wellness)" : "Plan meals (requested by Wellness)",
        description: note,
        steps: kind === "grocery" ? ["Draft list", "Build cart", "Await approval"] : ["Gather preferences", "Suggest meals"],
        status: "in_progress",
        correlationId: event.correlationId,
      });
    }
    return super.handleEvent(event);
  }

  protected async sandboxPlan(message: string, ctx: ToolContext): Promise<SandboxPlan> {
    const m = message.toLowerCase();
    if (/medication|medicine|pill|dose|due/.test(m) && !/took|taken|skipped/.test(m)) {
      return { reply: "Here's your medication schedule.", toolCalls: [{ name: "getMedicationSchedule", input: { when: "today" } }] };
    }
    if (/took|taken/.test(m)) {
      const name = /blood pressure|lisinopril/.test(m) ? "Lisinopril" : /metformin/.test(m) ? "Metformin" : "medication";
      return {
        reply: "Great, logging that now.",
        toolCalls: [{ name: "recordMedicationConfirmation", input: { medicationName: name, taken: true } }],
      };
    }
    if (/price|compare|cheap|good deal|how much|cost/.test(m)) {
      const item = ["milk", "eggs", "oats", "bread", "bananas", "chicken", "rice", "soup", "yogurt", "apples"].find((k) => m.includes(k.replace(/s$/, ""))) ?? "milk";
      return { reply: `Let me check current prices for ${item}.`, toolCalls: [{ name: "comparePrices", input: { query: item } }] };
    }
    if (/add (it|that|this|the (recommended|cheaper|best)( one)?)|draft cart|put (it|that) in/.test(m)) {
      return { reply: "Adding that to your draft cart.", toolCalls: [{ name: "addToDraftCart", input: { choice: "recommended" } }] };
    }
    if (/grocer|order|deliver|usual/.test(m)) {
      // Full §7 workflow: retrieve prefs -> list -> cart -> REQUEST APPROVAL.
      // Done imperatively here so a real pending approval appears for the user;
      // approving it runs requestOrderApproval, which places the order and asks
      // Finance to review the payment.
      const prefs = await ctx.memory.readShared("groceryPreferences").catch(() => []);
      const usual = (prefs[0]?.data.usual as string[]) ?? ["milk", "bread", "eggs", "bananas", "oats"];
      await ctx.memory.save("groceryLists", { items: usual, status: "draft" }, { tags: ["grocery"] });
      const lines = [
        { productId: "p_milk", name: "2% Milk, 1 gal", quantity: 1, price: 3.79 },
        { productId: "p_bread", name: "Whole Wheat Bread", quantity: 1, price: 2.99 },
        { productId: "p_eggs", name: "Large Eggs, dozen", quantity: 1, price: 4.29 },
        { productId: "p_bananas", name: "Bananas, bunch", quantity: 1, price: 1.89 },
        { productId: "p_oats", name: "Rolled Oats, 18oz", quantity: 1, price: 3.49 },
      ].map((l) => ({ ...l, lineTotal: Number((l.price * l.quantity).toFixed(2)) }));
      const total = Number(lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
      const cart = await ctx.memory.save("carts", { lines, total, status: "ready" }, { tags: ["cart"] });
      await ctx.approvals.request({
        toolName: "requestOrderApproval",
        toolInput: { cartId: cart.id },
        title: "Place grocery order",
        description: `Care wants to place your usual order: ${lines.length} items, $${total.toFixed(2)}.`,
        correlationId: ctx.correlationId,
      });
      return {
        reply: `I've put together your usual groceries — ${lines.length} items for $${total.toFixed(2)}. I just need your approval to place the order (see the card above).`,
      };
    }
    if (/pick ?up|collect|can'?t get to|bring me|drop off|deliver.*medicine|someone to get/.test(m) && /medic|pill|prescription|refill|pharmac/.test(m)) {
      // Offer to ask Guardian to coordinate a physical helper (authorized cross-agent
      // assistance request, carried over the Fetch.ai bridge when live).
      return {
        reply: "I'll ask Guardian to arrange someone to help collect that for you.",
        toolCalls: [{ name: "requestPickupHelp", input: { need: "collect a medication/refill the person cannot pick up", urgency: "soon" } }],
      };
    }
    if (/meal|dinner|eat|cook|recipe/.test(m)) {
      return { reply: "Here are a few easy ideas.", toolCalls: [{ name: "suggestMeals", input: { count: 3 } }] };
    }
    return {
      reply:
        "I can help with medications, groceries, and meals. Try 'what's due today?' or 'order my usual groceries'. (Sandbox mode: add an ANTHROPIC_API_KEY for full conversation.)",
    };
  }
}
