import { BaseAgent, type AgentConfig, type SandboxPlan } from "../base/BaseAgent";
import type { AgentTool, ToolContext } from "../base/types";
import { wellnessPrompt } from "./wellnessPrompt";
import { wellnessTools } from "./wellnessTools";
import { isRecallQuestion } from "./conversationContext";

export class WellnessAgent extends BaseAgent {
  readonly config: AgentConfig = {
    id: "wellness",
    displayName: "Wellness",
    tagline: "Talk about your day and stay connected.",
    welcome:
      "Hi, I'm Wellness. I'm here to talk and to listen — about your day, how you're feeling, whatever's on your mind. How are you today?",
    systemPrompt: wellnessPrompt,
    suggestedCommands: [
      "I haven't been sleeping well lately",
      "I feel a bit lonely today",
      "I had a lovely visit from my neighbor",
      "I'd love to talk to my daughter this week",
      "Do you remember what I told you about my garden?",
    ],
    theme: {
      accent: "#c98a2e",
      accentInk: "#835815",
      accentSoft: "#fbf0dc",
      gradient: "linear-gradient(135deg,#b3761e,#c98a2e)",
      icon: "sparkles",
    },
  };

  readonly tools: AgentTool[] = wellnessTools;

  protected async seed(): Promise<void> {
    await this.memory.save("observations", { note: "Enjoyed a walk in the garden", category: "mood", valence: "positive" }, { tags: ["wellness", "mood"] });
  }

  protected async sandboxPlan(message: string, _ctx: ToolContext): Promise<SandboxPlan> {
    const m = message.toLowerCase();
    if (/unsafe|threat|scared|someone is|pressuring|fell|hurt myself|danger/.test(m)) {
      const reply = "That sounds frightening, and your safety matters most. I'm going to let Guardian help with this right away.";
      return {
        reply,
        toolCalls: [
          { name: "escalateSafetyToGuardian", input: { summary: message, severity: "high" } },
          { name: "speakWellnessReply", input: { text: reply } },
        ],
      };
    }
    if (/no ?one to help|nobody to help|don'?t have anyone|no one can help|help me get groceries|need someone to/.test(m)) {
      return {
        reply: "You shouldn't have to manage that alone. Let me ask Guardian to arrange someone to help you.",
        toolCalls: [{ name: "requestHumanAssistance", input: { need: message.slice(0, 280), urgency: "soon" } }],
      };
    }
    if (/can'?t cook|can'?t prepare|hard to make|no food|can'?t get groceries|too tired to cook/.test(m)) {
      return {
        reply: "Thank you for telling me. Let me ask Care to help with meals so you don't have to worry about it.",
        toolCalls: [{ name: "requestCareAssist", input: { kind: "meal", note: message.slice(0, 280) } }],
      };
    }
    if (isRecallQuestion(message)) {
      // "Do you remember what I told you about my garden?" -> verified Backboard recall.
      return {
        reply: "Let me think back to what you've told me.",
        toolCalls: [{ name: "recallConversationContext", input: { query: message } }],
      };
    }
    const valence = /lonely|sad|can'?t sleep|pain|not eating|alone/.test(m) ? "negative" : /good|happy|lovely|enjoyed|visit/.test(m) ? "positive" : "neutral";
    const reply =
      valence === "negative"
        ? "I'm really glad you told me. I'm here with you. Let's sit with that for a moment, what's been the hardest part?"
        : valence === "positive"
          ? "That's wonderful to hear. Tell me more, what made it special?"
          : "I'm listening. Tell me more about your day.";
    return {
      reply,
      toolCalls: [
        { name: "startConversationalCheckIn", input: {} },
        // The full pipeline: Bitdeer extraction -> policy -> Convex -> Moss ->
        // Backboard -> Tiger Data -> trend -> contextual follow-up.
        { name: "processWellnessConversation", input: { text: message } },
        { name: "saveWellnessMemory", input: { note: message.slice(0, 200), category: "mood", valence } },
        // Speak the reply aloud (Cartesia when configured, else browser speech).
        { name: "speakWellnessReply", input: { text: reply } },
      ],
    };
  }
}
