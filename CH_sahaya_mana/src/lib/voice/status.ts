/**
 * Voice provider status for the UI. "live" only when a key is configured AND the client is wired AND
 * Cartesia hasn't rejected the key since the last successful call.
 */
export interface VoiceHealth {
  lastOkAt: number | null;
  lastAuthFailureAt: number | null;
  lastFailureKind: string | null;
  /** Browser-reported real-time streaming outcomes (no content). */
  lastStreamOkAt?: number | null;
  lastStreamFailureAt?: number | null;
}

export interface VoiceStatus {
  provider: "cartesia" | "browser";
  mode: "live" | "unavailable";
  rejected: boolean;
  verified: boolean;
  label: string;
  detail: string;
  /** Real-time conversation streaming: live only after a stream actually worked and hasn't failed since. */
  streaming: { mode: "live" | "unverified" | "unavailable"; label: string };
}

function streamingFor(base: Omit<VoiceStatus, "streaming">, h: VoiceHealth): VoiceStatus["streaming"] {
  if (base.provider !== "cartesia") return { mode: "unavailable", label: "Browser speech (not Cartesia)" };
  const ok = h.lastStreamOkAt ?? null;
  const bad = h.lastStreamFailureAt ?? null;
  if (ok !== null && (bad === null || ok > bad)) return { mode: "live", label: "Cartesia streaming (live)" };
  if (bad !== null) return { mode: "unavailable", label: "Cartesia streaming failed — falls back to browser speech" };
  return { mode: "unverified", label: "Cartesia streaming (not yet verified)" };
}

export function voiceStatus(configured: boolean, health: VoiceHealth): VoiceStatus {
  const base = baseStatus(configured, health);
  return { ...base, streaming: streamingFor(base, health) };
}

function baseStatus(configured: boolean, health: VoiceHealth): Omit<VoiceStatus, "streaming"> {
  if (!configured) {
    return {
      provider: "browser",
      mode: "unavailable",
      rejected: false,
      verified: false,
      label: "Browser speech (not Cartesia)",
      detail: "CARTESIA_API_KEY isn't set — the app uses your browser's built-in speech where available.",
    };
  }
  const rejected = health.lastAuthFailureAt !== null && (health.lastOkAt === null || health.lastAuthFailureAt > health.lastOkAt);
  if (rejected) {
    return {
      provider: "browser",
      mode: "unavailable",
      rejected: true,
      verified: false,
      label: "Browser speech (not Cartesia)",
      detail: "Cartesia rejected the key — falling back to your browser's built-in speech.",
    };
  }
  return {
    provider: "cartesia",
    mode: "live",
    rejected: false,
    verified: health.lastOkAt !== null,
    label: "Cartesia voice",
    detail:
      health.lastOkAt !== null
        ? "Cartesia speech-to-text (ink-whisper) and voice (sonic-3.6) are connected."
        : "CARTESIA_API_KEY is set and the Cartesia client is wired; the key is checked on first use.",
  };
}
