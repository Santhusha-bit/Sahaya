/**
 * Shared setup for the narrated Care demos. Everything is fictional and runs against sandbox
 * adapters with a controllable clock; no credentials, network calls or real services are used.
 */
import { createSahayaRuntime } from "@/agents";
import { MemoryStore } from "@/agents/base/MemoryStore";
import type { AgentContext } from "@/agents/base/types";
import type { CareAgent } from "@/agents/care/CareAgent";
import { careServices } from "@/agents/care/careTools";
import { DEMO_CAREGIVER, DEMO_LIMITED_CAREGIVER, demoStart, seedDemoPermissions } from "@/agents/care/data/demoProfile";
import { DemoClock, friendlyDateTime } from "@/agents/care/domain/time";
import { UnavailableLLMClient } from "@/agents/base/llm";

export const USER_ID = "demo_margaret";
export const margaret: AgentContext = { userId: USER_ID, actor: { id: USER_ID, role: "older_adult" } };
export const daughter: AgentContext = { userId: USER_ID, actor: { id: DEMO_CAREGIVER.id, role: "caregiver" } };
export const neighbor: AgentContext = { userId: USER_ID, actor: { id: DEMO_LIMITED_CAREGIVER.id, role: "caregiver" } };

export async function demoWorld() {
  const clock = new DemoClock(demoStart());
  const store = new MemoryStore();
  // Claude is deliberately not used: demos must run without credentials. Where Claude would turn a
  // sentence into a tool call, the demo shows the structured call it would make ("intent").
  const runtime = createSahayaRuntime({ store, llm: new UnavailableLLMClient(), now: clock.now, integrationMode: (id) => (id === "claude" || id === "telephony" ? "unavailable" : "sandbox") });
  const care = runtime.get("care") as CareAgent;
  await care.seedDemo(margaret);
  await seedDemoPermissions(store, USER_ID);
  const services = () =>
    careServices({
      store: (care as unknown as { store: Parameters<typeof careServices>[0]["store"] }).store,
      now: clock.now,
      integrationMode: (id) => (id === "claude" || id === "telephony" ? "unavailable" : "sandbox"),
      emit: (target, type, payload) => runtime.bus.publish("care", target, type, payload, margaret),
      ctx: {},
    });
  return { clock, store, runtime, care, services };
}

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export const say = {
  title(t: string) {
    console.log(`\n${BOLD}${t}${RESET}`);
    console.log(`${DIM}Fictional demo data · sandbox pharmacy/grocery/delivery/voice · simulated clock · no credentials${RESET}`);
  },
  step(n: number, t: string) {
    console.log(`\n${BOLD}${CYAN}${n}. ${t}${RESET}`);
  },
  clock(now: number) {
    console.log(`${DIM}   ⏱  Sandbox clock: ${friendlyDateTime(now, "America/Los_Angeles")}${RESET}`);
  },
  care(text: string) {
    for (const line of text.split("\n")) console.log(`   🗣  Care: “${line}”`);
  },
  user(who: string, text: string) {
    console.log(`   💬 ${who}: “${text}”`);
  },
  info(text: string) {
    console.log(`   ${text}`);
  },
  ok(text: string) {
    console.log(`   ${GREEN}✓ ${text}${RESET}`);
  },
  warn(text: string) {
    console.log(`   ${YELLOW}! ${text}${RESET}`);
  },
  blocked(text: string) {
    console.log(`   ${RED}✕ ${text}${RESET}`);
  },
  intent(tool: string, input: unknown) {
    console.log(`   ${DIM}→ intent (what Claude would call; scripted here): ${tool} ${JSON.stringify(input)}${RESET}`);
  },
};
