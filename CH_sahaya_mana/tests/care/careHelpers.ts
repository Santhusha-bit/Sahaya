import { createSahayaRuntime } from "@/agents";
import { MemoryStore } from "@/agents/base/MemoryStore";
import type { AgentContext } from "@/agents/base/types";
import type { CareAgent } from "@/agents/care/CareAgent";
import { careServices } from "@/agents/care/careTools";
import { DEMO_CAREGIVER, DEMO_LIMITED_CAREGIVER, demoStart, seedDemoPermissions } from "@/agents/care/data/demoProfile";
import { DemoClock } from "@/agents/care/domain/time";
import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { ScriptedLLM } from "../helpers";

export const MARGARET = "user_margaret_demo";
export const margaret: AgentContext = { userId: MARGARET, actor: { id: MARGARET, role: "older_adult" } };
export const daughter: AgentContext = { userId: MARGARET, actor: { id: DEMO_CAREGIVER.id, role: "caregiver" } };
export const neighbor: AgentContext = { userId: MARGARET, actor: { id: DEMO_LIMITED_CAREGIVER.id, role: "caregiver" } };
export const stranger: AgentContext = { userId: MARGARET, actor: { id: "cg_unknown", role: "caregiver" } };
export const system: AgentContext = { userId: MARGARET, actor: { id: "agent:care", role: "system" } };

const DEFAULT_MODES: Partial<Record<IntegrationId, IntegrationMode>> = { telephony: "unavailable", claude: "unavailable" };

/** Real runtime (all four agents) + Margaret seeded + a fixed demo clock at 07:55 local. */
export async function careWorld(opts: { start?: number; modes?: Partial<Record<IntegrationId, IntegrationMode>>; llm?: ScriptedLLM; seed?: boolean } = {}) {
  const clock = new DemoClock(opts.start ?? demoStart());
  const store = new MemoryStore();
  const modes = { ...DEFAULT_MODES, ...opts.modes };
  const runtime = createSahayaRuntime({
    store,
    llm: opts.llm ?? new ScriptedLLM(),
    now: clock.now,
    integrationMode: (id) => modes[id] ?? "sandbox",
  });
  const care = runtime.get("care") as CareAgent;
  if (opts.seed !== false) {
    await care.seedDemo(margaret);
    await seedDemoPermissions(store, MARGARET);
  }
  const services = () =>
    careServices({
      store: (care as unknown as { store: Parameters<typeof careServices>[0]["store"] }).store,
      now: clock.now,
      integrationMode: (id) => modes[id] ?? "sandbox",
      emit: (target, type, payload) => runtime.bus.publish("care", target, type, payload, margaret),
      ctx: {},
    });
  return { clock, store, runtime, care, services, modes };
}

export const MIN = 60_000;
