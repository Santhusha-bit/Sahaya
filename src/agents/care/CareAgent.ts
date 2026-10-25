import { BaseAgent, type AgentConfig, type AgentReply, type SandboxPlan } from "../base/BaseAgent";
import type { AgentEvent, AgentTask, AgentTool, ToolContext } from "../base/types";
import { synthesizeSpeech } from "@/integrations/cartesia";
import { carePrompt } from "./carePrompt";
import { careTools } from "./careTools";
import {
  backendLabel,
  parseRequestedItems,
  prepareCartFromDiscovery,
  runGroceryDiscovery,
  usualGroceries,
} from "./groceryWorkflow";

const USUAL_KEYS = ["milk", "bread", "eggs", "bananas", "oats", "soup", "yogurt", "cookies"];

function itemKeyIn(text: string): string | null {
  return USUAL_KEYS.find((k) => new RegExp(`\\b${k.replace(/s$/, "")}s?\\b`).test(text)) ?? null;
}

export type ShoppingIntent =
  | { kind: "usual"; exclude: string[] }
  | { kind: "track" }
  | { kind: "remove"; itemKey: string }
  | { kind: "approve_by_voice" };

/** Deterministic shopping intent parser used by both the sandbox planner and the live fast path. */
export function shoppingIntent(message: string): ShoppingIntent | null {
  const m = message.toLowerCase();
  if (/\b(where|status|track|tracking)\b.*\b(order|groceries|delivery)\b|\bhas my (order|groceries)\b|\bwhen will (my )?(order|groceries)\b/.test(m)) {
    return { kind: "track" };
  }
  if (/^\s*(yes|yeah|yep|ok(ay)?|sure|approve|go ahead|buy it|place (the|my) order|confirm)\b/.test(m) && !/\busual\b/.test(m)) {
    return { kind: "approve_by_voice" };
  }
  const removeMatch = /\b(remove|take off|take out|drop|delete|don'?t (want|need))\b/.test(m) ? itemKeyIn(m) : null;
  if (removeMatch && !/\busual\b/.test(m)) return { kind: "remove", itemKey: removeMatch };
  if (/grocer|order|deliver|usual|shopping/.test(m)) {
    const exclude: string[] = [];
    const without = m.match(/\b(?:without|except|but no|no|skip)\b(.*)$/);
    if (without) for (const k of USUAL_KEYS) if (new RegExp(`\\b${k.replace(/s$/, "")}s?\\b`).test(without[1])) exclude.push(k);
    return { kind: "usual", exclude };
  }
  return null;
}

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
      "Where is my grocery order?",
      "Buy whole milk, coffee and apples",
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
   * Live-LLM hot path for shopping: run the deterministic shopping tools first,
   * then one model call phrases the result. Spoken "yes" and item removal need
   * the conversation/cart state, so they use the normal tool loop instead.
   */
  protected fastPath(message: string): { name: string; input: Record<string, unknown> }[] | null {
    const intent = shoppingIntent(message);
    if (intent?.kind === "usual") return [{ name: "buildUsualCart", input: intent.exclude.length ? { exclude: intent.exclude } : {} }];
    if (intent?.kind === "track") return [{ name: "trackOrder", input: {} }];
    return null;
  }

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
    // An explicit list ("buy milk and eggs") gets live Apify discovery; "my usual
    // groceries" uses the history-based cart below.
    const explicitList = parseRequestedItems(message);
    if (explicitList) {
      // Full workflow: preferred items -> Apify product discovery -> compare ->
      // cart -> REQUEST APPROVAL. Done imperatively so a real pending approval
      // appears for the user; approving it runs requestOrderApproval, which
      // places the order and asks Finance to review the payment.
      const items = explicitList;
      await ctx.memory.save("groceryLists", { items, status: "draft" }, { tags: ["grocery"] });
      const { discoveryId, discovery } = await runGroceryDiscovery(ctx, items);
      const cart = await prepareCartFromDiscovery(ctx, discoveryId, { requestApproval: true });
      const source = backendLabel(discovery);
      if (!cart.ok) {
        return { reply: `I searched ${items.length} item(s) using ${source}, but couldn't find current prices to build a cart. Want to try different items?` };
      }
      const { plan } = cart;
      const stores = plan.retailers.length ? ` from ${plan.retailers.slice(0, 3).join(", ")}${plan.retailers.length > 3 ? " and others" : ""}` : "";
      const missing = plan.missing.length ? ` I couldn't find a price for ${plan.missing.map((x) => x.query).join(", ")}.` : "";
      return {
        reply: `I checked fresh prices for your list using ${source}. Your cart is ${plan.lines.length} item(s) for $${plan.total.toFixed(2)}${stores}.${missing} Please review it and approve when you're ready (see the card above).`,
      };
    }
    const shopping = shoppingIntent(message);
    if (shopping?.kind === "approve_by_voice") {
      // Spoken "yes" never spends money: approval is only an explicit tap on the
      // approval card, enforced by the approval gate (no tool can approve).
      return { reply: "To keep your money safe, please tap the big green Approve button on your cart to confirm the purchase." };
    }
    if (shopping?.kind === "track") {
      return { reply: "Let me check on your order.", toolCalls: [{ name: "trackOrder", input: {} }] };
    }
    if (shopping?.kind === "remove") {
      const [cart] = (await ctx.memory.list("carts", { tag: "shopping" })).filter((c) => c.data.status === "ready");
      if (!cart) return { reply: "There isn't an open cart to change right now. Say 'order my usual groceries' to start one." };
      return {
        reply: `Okay, I'll take the ${shopping.itemKey} off.`,
        toolCalls: [{ name: "removeCartItem", input: { cartId: cart.id, itemKey: shopping.itemKey } }],
      };
    }
    if (shopping?.kind === "usual") {
      // Full shopping workflow: history/preferences -> product search (Apify when
      // live) -> substitution policy -> accessible cart -> approval for that exact
      // cart. Approving it checks out (sandbox) and asks Finance to review payment.
      return {
        reply: "Here's your usual grocery order. Please look over the cart and tap Approve when you're happy with it.",
        toolCalls: [{ name: "buildUsualCart", input: shopping.exclude.length ? { exclude: shopping.exclude } : {} }],
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
