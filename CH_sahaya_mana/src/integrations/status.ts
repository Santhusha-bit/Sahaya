/**
 * Honest integration status. Every external dependency is reported as exactly one of:
 *  - live:        real credentials configured; calls hit the real service
 *  - sandbox:     runs against a test/simulated backend (clearly labelled in the UI)
 *  - unavailable: not configured; features depending on it are disabled, never faked
 */
import { appEnv } from "@/lib/config/env";
import { homeServicesEnabled, sandboxProviderAllowed } from "@/integrations/getterdone/provider";

export type IntegrationMode = "live" | "sandbox" | "unavailable";

export type IntegrationId =
  | "claude"
  | "convex"
  | "storage"
  | "auth0"
  | "cartesia"
  | "moss"
  | "commerce"
  | "pharmacy"
  | "telephony"
  | "benefits"
  | "delivery"
  | "voice"
  | "getterdone";

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  purpose: string;
  mode: IntegrationMode;
  detail: string;
}

type Env = Record<string, string | undefined>;

const has = (env: Env, ...keys: string[]) => keys.every((k) => Boolean(env[k]?.trim()));

/*
 * "live" means a real client is wired in this codebase AND credentials are configured. A key that is
 * set for a service with no adapter yet is reported as unavailable, with the reason, never as live.
 * Auth0 and Convex additionally require an explicit owner switch (SAHAYA_AUTH=auth0, SAHAYA_STORAGE=convex).
 * Claude (src/agents/base/llm.ts) and Cartesia (src/integrations/cartesia.ts) are the external clients
 * wired today. Keys are not validated until the first call; at runtime, src/lib/server/voice.ts lowers
 * Cartesia/voice from live when Cartesia rejects the key, and the UI says so.
 */

export function resolveIntegrations(env: Env = process.env): IntegrationStatus[] {
  return [
    {
      id: "claude",
      name: "Claude (Anthropic)",
      purpose: "Agent reasoning and tool planning",
      ...(has(env, "ANTHROPIC_API_KEY")
        ? { mode: "live", detail: "ANTHROPIC_API_KEY configured (checked on first use)" }
        : { mode: "unavailable", detail: "Set ANTHROPIC_API_KEY to enable agent reasoning" }),
    },
    {
      id: "convex",
      name: "Convex",
      purpose: "Secure database for signed-in people (memory, conversations, approvals)",
      ...(appEnv(env, "STORAGE") === "convex" && has(env, "NEXT_PUBLIC_CONVEX_URL")
        ? {
            mode: "live",
            detail: "Enabled (SAHAYA_STORAGE=convex). Sahaya doesn't verify the deployment or its functions; if they're missing, signed-in requests fail with \"database unavailable\" instead of saving locally.",
          }
        : {
            mode: "unavailable",
            detail: has(env, "NEXT_PUBLIC_CONVEX_URL")
              ? "Code and schema are in convex/, but not enabled or deployed (needs an approved development deployment and SAHAYA_STORAGE=convex). Signed-in people can't save anything until then."
              : "Not configured. Signed-in people can't save anything until a Convex deployment is set up.",
          }),
    },
    {
      id: "storage",
      name: "Local test storage (this computer)",
      purpose: "Only for explicit local test mode (npm run dev:local) with non-sensitive data",
      ...(env.NODE_ENV === "development" && appEnv(env, "LOCAL_MODE") === "nonsensitive"
        ? appEnv(env, "STORE") === "memory"
          ? { mode: "sandbox", detail: "Local test mode, memory only: nothing is saved." }
          : { mode: "sandbox", detail: "Local test mode: saved to .data/sahaya-store.json on this computer (owner-only file, git-ignored). Not for real health information." }
        : { mode: "unavailable", detail: "Off. Never used in production or for signed-in people." }),
    },
    {
      id: "auth0",
      name: "Auth0",
      purpose: "Sign-in; every request's identity comes from the verified session",
      ...(appEnv(env, "AUTH") === "auth0" && has(env, "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET")
        ? { mode: "live", detail: "Enabled (SAHAYA_AUTH=auth0). The sign-in flow depends on the Auth0 application settings, which Sahaya can't check." }
        : has(env, "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET")
          ? { mode: "unavailable", detail: "SDK installed and settings present, but not enabled. Set SAHAYA_AUTH=auth0 after configuring the Auth0 application; until then nobody can sign in." }
          : { mode: "unavailable", detail: "Not configured. Nobody can sign in; only explicit local test mode works." }),
    },
    {
      id: "cartesia",
      name: "Cartesia",
      purpose: "Natural voice (speech-to-text and text-to-speech)",
      ...(has(env, "CARTESIA_API_KEY")
        ? {
            mode: "live",
            detail: "CARTESIA_API_KEY configured; speech-to-text (ink-whisper) and voice (sonic-3.6) are wired. The key is checked on first use.",
          }
        : {
            mode: "unavailable",
            detail: "Set CARTESIA_API_KEY — voice falls back to the browser's built-in speech, labelled as such",
          }),
    },
    {
      id: "moss",
      name: "Moss",
      purpose: "Personal semantic memory",
      ...(has(env, "MOSS_PROJECT_ID", "MOSS_PROJECT_KEY")
        ? { mode: "unavailable", detail: "Moss keys are set, but the Moss client isn't wired yet — memory search uses keyword matching" }
        : { mode: "unavailable", detail: "Moss not configured — memory search uses keyword matching" }),
    },
    {
      id: "commerce",
      name: "Grocery commerce",
      purpose: "Product search and ordering",
      mode: "sandbox",
      detail: "Simulated grocery catalog; no real orders are placed",
    },
    {
      id: "pharmacy",
      name: "Pharmacy",
      purpose: "Prescription refills",
      mode: "sandbox",
      detail: "Local pharmacy simulator — refill requests are never transmitted to a real pharmacy",
    },
    {
      id: "telephony",
      name: "Calls & SMS",
      purpose: "Trusted-contact notification and emergency assistance",
      mode: "unavailable",
      detail: "No telephony provider configured — notifications are recorded in-app only",
    },
    {
      id: "benefits",
      name: "Benefits lookup",
      purpose: "Public benefits eligibility search",
      mode: "sandbox",
      detail: "Curated offline benefits dataset",
    },
    {
      id: "delivery",
      name: "Delivery",
      purpose: "Grocery delivery tracking and meal delivery booking",
      mode: "sandbox",
      detail: "Simulated delivery lifecycle — nothing is delivered, booked or charged",
    },
    {
      id: "voice",
      name: "Voice reminders & check-ins",
      purpose: "Medication reminders, follow-ups and check-in conversations",
      ...(has(env, "CARTESIA_API_KEY")
        ? {
            mode: "live",
            detail: "Reminders are spoken with Cartesia inside the app while it's open; no phone calls are placed",
          }
        : {
            mode: "sandbox",
            detail: "Voice simulator — prompts are recorded in the app (browser speech can read them aloud); no calls are placed",
          }),
    },
    (() => {
      const enabled = homeServicesEnabled(env);
      const allowed = sandboxProviderAllowed(env);
      return {
        id: "getterdone" as const,
        name: "GetterDone (home repairs)",
        purpose: "Plumbers, electricians, handymen, appliance, heating/cooling and tech help",
        // The only place the sandbox is named. Live booking stays disabled in this build.
        ...(enabled && allowed
          ? { mode: "sandbox" as const, detail: "Sandbox provider: bookings stay inside Sahaya; nothing is sent to GetterDone." }
          : { mode: "unavailable" as const, detail: enabled ? "Sandbox provider refused in this production configuration." : "Switched off (SAHAYA_HOME_SERVICES=off)." }),
      };
    })(),
  ];
}

export function getIntegration(id: IntegrationId, env: Env = process.env): IntegrationStatus {
  const found = resolveIntegrations(env).find((i) => i.id === id);
  if (!found) throw new Error(`Unknown integration ${id}`);
  return found;
}
