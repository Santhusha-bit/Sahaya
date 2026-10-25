/**
 * GetterDone configuration (server-side only; never import from client components).
 *
 * Source: https://www.getterdone.ai/docs/api (Overview, Authentication) and the published OpenAPI document at
 * https://getterdone.ai/api/openapi (fetched 2026-10-24, "GetterDone Agent API" 1.0.0).
 *  - Base URL: https://getterdone.ai
 *  - Credential: GETTERDONE_API_KEY="gd_<clientId>:<clientSecret>" (machine-to-machine OAuth2 client_credentials),
 *    exchanged at POST /api/auth/agent/token for a 1-hour bearer token.
 *
 * Variables (all server-side; never NEXT_PUBLIC_*):
 *  - GETTERDONE_API_KEY      optional. Without it nothing is sent to GetterDone; the demo uses simulated data.
 *  - GETTERDONE_DEMO_MODE    defaults to demo. Anything other than exactly "false" means demo. In THIS build the
 *                            live booking path is hard-disabled even when it is "false" (see client.ts).
 *  - GETTERDONE_LIVE_QUOTES  "true" allows the documented read-only price check (POST /api/tasks/quote, "Nothing is
 *                            charged") when a valid key is present. Off by default.
 */
export const GETTERDONE_BASE_URL = "https://getterdone.ai";

export type EnvLike = Partial<Record<string, string | undefined>>;

export interface GetterDoneCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GetterDoneConfig {
  /** True unless GETTERDONE_DEMO_MODE is exactly "false". */
  demoMode: boolean;
  /** A key in the documented format is present (value never exposed). */
  keyPresent: boolean;
  /** Why the key can't be used, in words safe to show (never the value). */
  keyProblem: string | null;
  /** Live read-only price checks are allowed (opt-in + valid key). */
  liveQuotes: boolean;
  /** Internal only: never log, return or render. */
  readonly credentials: GetterDoneCredentials | null;
}

const KEY_FORMAT = /^gd_[^:\s]+:[^:\s]+$/;

export function getterdoneConfig(env: EnvLike = process.env): GetterDoneConfig {
  const demoMode = (env.GETTERDONE_DEMO_MODE ?? "").trim().toLowerCase() !== "false";
  const raw = (env.GETTERDONE_API_KEY ?? "").trim();
  let credentials: GetterDoneCredentials | null = null;
  let keyProblem: string | null = null;
  if (!raw) {
    keyProblem = "GETTERDONE_API_KEY isn't set, so the demo uses simulated information only.";
  } else if (!KEY_FORMAT.test(raw)) {
    keyProblem = "GETTERDONE_API_KEY is set but isn't in the documented gd_<clientId>:<clientSecret> format, so it isn't used.";
  } else {
    const at = raw.indexOf(":");
    credentials = { clientId: raw.slice(0, at), clientSecret: raw.slice(at + 1) };
  }
  const liveQuotes = credentials !== null && (env.GETTERDONE_LIVE_QUOTES ?? "").trim().toLowerCase() === "true";
  return { demoMode, keyPresent: credentials !== null, keyProblem, liveQuotes, credentials };
}

/** Safe, value-free description for the integration status list and the dashboard. */
export function describeGetterDone(cfg: GetterDoneConfig) {
  return {
    demoMode: cfg.demoMode,
    keyPresent: cfg.keyPresent,
    liveQuotes: cfg.liveQuotes,
    liveBooking: false as const,
    note: cfg.keyProblem,
  };
}
