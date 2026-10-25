import "server-only";
import type { IntegrationId, IntegrationMode } from "@/integrations/status";
import { CartesiaClient, type CartesiaError } from "@/integrations/cartesia";
import type { VoiceDeps } from "@/lib/voice/handlers";
import { RateLimiter } from "@/lib/voice/rateLimit";
import { voiceStatus, type VoiceHealth } from "@/lib/voice/status";
import { CARTESIA_DEFAULT_VOICE_ID } from "@/integrations/cartesia";
import { errorResponse } from "./http";
import { getSessionContext } from "./session";

/**
 * The only place the Cartesia key is read (process.env, server side). It's passed to the client in
 * memory and never returned, logged or sent to the browser.
 */
const g = globalThis as unknown as {
  sahayaVoice?: { health: VoiceHealth; client: CartesiaClient | null; keyFingerprint: string | null; limiter: RateLimiter };
};

function state() {
  g.sahayaVoice ??= {
    health: { lastOkAt: null, lastAuthFailureAt: null, lastFailureKind: null, lastStreamOkAt: null, lastStreamFailureAt: null },
    client: null,
    keyFingerprint: null,
    limiter: new RateLimiter(),
  };
  return g.sahayaVoice;
}

export function configuredVoiceId() {
  return process.env.CARTESIA_VOICE_ID?.trim() || CARTESIA_DEFAULT_VOICE_ID;
}

function configuredKey(): string | null {
  const k = process.env.CARTESIA_API_KEY?.trim();
  return k ? k : null;
}

export function getCartesiaClient(): CartesiaClient | null {
  const key = configuredKey();
  const s = state();
  if (!key) return null;
  // Rebuild only if the configured key changed (compared by length+edges in memory; never logged).
  const fp = `${key.length}:${key.slice(0, 2)}:${key.slice(-2)}`;
  if (!s.client || s.keyFingerprint !== fp) {
    s.client = new CartesiaClient({ apiKey: key, voiceId: configuredVoiceId() });
    s.keyFingerprint = fp;
    s.health = { lastOkAt: null, lastAuthFailureAt: null, lastFailureKind: null, lastStreamOkAt: null, lastStreamFailureAt: null };
  }
  return s.client;
}

export function recordVoiceResult(ok: boolean, err?: CartesiaError) {
  const h = state().health;
  if (ok) {
    h.lastOkAt = Date.now();
    h.lastFailureKind = null;
  } else if (err) {
    h.lastFailureKind = err.kind;
    if (err.kind === "auth") h.lastAuthFailureAt = Date.now();
  }
}

export function getVoiceStatus() {
  return voiceStatus(configuredKey() !== null, state().health);
}

/** Runtime integration mode with live health: a rejected key turns Cartesia off and voice back to the simulator. */
export function voiceIntegrationOverlay(id: IntegrationId, base: IntegrationMode): IntegrationMode {
  if (id !== "cartesia" && id !== "voice") return base;
  const status = getVoiceStatus();
  if (id === "cartesia") return status.mode;
  return status.mode === "live" ? "live" : "sandbox";
}

export function recordStreamResult(ok: boolean, kind: string) {
  const h = state().health;
  if (ok) h.lastStreamOkAt = Date.now();
  else {
    h.lastStreamFailureAt = Date.now();
    if (kind === "auth") h.lastAuthFailureAt = Date.now();
  }
}

export const voiceDeps: VoiceDeps & { voiceId(): string } = {
  voiceId: configuredVoiceId,
  rateLimit: (key, bucket) => state().limiter.take(key, bucket),
  recordStream: recordStreamResult,
  client: getCartesiaClient,
  recordResult: recordVoiceResult,
  session: getSessionContext,
  async agent(id, ctx) {
    // Lazy import: runtime.ts also imports this module (for the integration overlay).
    const { getRuntime } = await import("./runtime");
    return (await getRuntime(ctx)).get(id);
  },
  errorResponse,
  log(event, data) {
    // Sizes, lengths and status only — never transcripts, text or audio.
    console.info(`[voice] ${event}`, data);
  },
};
