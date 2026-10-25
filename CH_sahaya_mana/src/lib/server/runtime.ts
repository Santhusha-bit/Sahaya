import "server-only";
import { createSahayaRuntime } from "@/agents";
import { resolveLocalStorePath } from "@/lib/server/localStorePath";
import type { AgentRuntime } from "@/agents/base/AgentRuntime";
import type { AgentStore } from "@/agents/base/AgentStore";
import { AgentError } from "@/agents/base/errors";
import { createLLMClient } from "@/agents/base/llm";
import { MemoryStore } from "@/agents/base/MemoryStore";
import type { AgentContext } from "@/agents/base/types";
import type { CareAgent } from "@/agents/care/CareAgent";
import { seedDemoPermissions } from "@/agents/care/data/demoProfile";
import { DemoClock } from "@/agents/care/domain/time";
import { localModeEnabled } from "@/lib/auth/identity";
import { ConvexStore } from "@/lib/storage/ConvexStore";
import { FileStore } from "@/lib/storage/FileStore";
import { resolveIntegrations } from "@/integrations/status";
import { decideStorage, type StorageDecision } from "./storagePolicy";
import { resolveRequest, type RequestAuth } from "./session";
import { voiceIntegrationOverlay } from "./voice";

/**
 * Runtime per request, chosen by the storage policy (src/lib/server/storagePolicy.ts):
 *  - Signed-in people: a fresh runtime over a ConvexStore authenticated with THEIR token, built for this request
 *    only (no shared user clients or cross-user caches). If Convex isn't enabled/reachable → 503, never local.
 *  - Explicit non-sensitive local mode (development only): one process-wide runtime over the local FileStore
 *    (.data/sahaya-store.json, mode 600) or MemoryStore (SAHAYA_STORE=memory).
 * The sandbox clock is real time plus an offset that local mode can move forward; it holds no user data.
 */
/** Resolved only when the local store is actually opened (explicit local mode), so other modes never touch .data. */
export const localStorePath = () => resolveLocalStorePath(process.env, `${process.cwd()}/.data`);

type SeedableStore = AgentStore & Pick<MemoryStore, "setCaregiverPermission">;

const g = globalThis as unknown as {
  sahayaLocal?: { runtime: AgentRuntime; store: SeedableStore; kind: "file" | "memory" };
  sahayaClock?: DemoClock;
  /** Ids already initialized in this process (ids only, no data). */
  sahayaInitialized?: Set<string>;
};

function clock() {
  return (g.sahayaClock ??= new DemoClock());
}

function integrationMode() {
  const modes = new Map(resolveIntegrations().map((i) => [i.id, i.mode]));
  // Env-based modes, with live voice health on top (a rejected Cartesia key drops voice back to the simulator).
  return (id: Parameters<typeof voiceIntegrationOverlay>[0]) => voiceIntegrationOverlay(id, modes.get(id) ?? "unavailable");
}

function localRuntime(kind: "file" | "memory") {
  if (!g.sahayaLocal || g.sahayaLocal.kind !== kind) {
    const store = kind === "file" ? new FileStore(localStorePath()) : new MemoryStore();
    g.sahayaLocal = { runtime: createSahayaRuntime({ store, llm: createLLMClient(), now: clock().now, integrationMode: integrationMode() }), store, kind };
  }
  return g.sahayaLocal;
}

function runtimeFor(decision: StorageDecision): { runtime: AgentRuntime; store: SeedableStore } {
  if (decision.kind === "convex") {
    const store = new ConvexStore(decision.url, decision.token);
    return { runtime: createSahayaRuntime({ store, llm: createLLMClient(), now: clock().now, integrationMode: integrationMode() }), store };
  }
  return localRuntime(decision.kind);
}

/** Local-only tools (sandbox clock, caregiver previews of the demo) exist only in explicit local mode. */
export function demoModeActive() {
  return localModeEnabled(process.env);
}

/** Human description of where this request's data lives (no secrets). */
export function describeStorage(decision: StorageDecision) {
  if (decision.kind === "convex") return "Saved in the secure database (Convex)";
  if (decision.kind === "file") return "Local test mode: saved in a file on this computer — don't enter real health information";
  return "Local test mode: not saved (memory only)";
}

export async function getRequestStorage(): Promise<{ auth: RequestAuth; decision: StorageDecision }> {
  const auth = await resolveRequest();
  return { auth, decision: decideStorage(auth.identity, process.env) };
}

export async function getRuntime(ctx: AgentContext): Promise<AgentRuntime> {
  const { auth, decision } = await getRequestStorage();
  // A runtime is only built for the verified person (or their own demo profile) of this request, or — for a
  // caregiver view — with the verified caregiver as the actor. The caregiver's grant is checked by careContext
  // and again by the store (Convex functions) on every read/write.
  const caregiverView = ctx.actor.role === "caregiver" && ctx.actor.id === auth.userId && auth.identity.kind === "user";
  if (ctx.userId !== auth.userId && !caregiverView) throw new AgentError("PERMISSION_DENIED", "Not allowed.");
  const { runtime, store } = runtimeFor(decision);
  if (caregiverView && ctx.userId !== auth.userId) return runtime; // never initialise or seed someone else's data

  const init = (g.sahayaInitialized ??= new Set());
  const key = `${decision.kind}:${auth.userId}`;
  if (!init.has(key)) {
    const self: AgentContext = { userId: auth.userId, actor: { id: auth.userId, role: "older_adult" } };
    await runtime.initializeAll(self);
    // Fictional sample data only for the separately selected demo profile — never for a real person.
    if (auth.profile === "demo") {
      await (runtime.get("care") as CareAgent).seedDemo(self);
      await seedDemoPermissions(store, auth.userId);
    }
    init.add(key);
  }
  return runtime;
}

/** The sandbox clock (moved only in local mode). */
export function getDemoClock(): DemoClock {
  return clock();
}
