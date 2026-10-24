/**
 * Centralised, honest view of which external integrations are configured.
 * Acceptance criterion 12: integrations are identified as live / sandbox / unavailable.
 */

export type IntegrationMode = "live" | "sandbox" | "unavailable";

export interface IntegrationStatus {
  key: string;
  label: string;
  mode: IntegrationMode;
  detail: string;
}

function has(name: string): boolean {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export const AGENT_MODEL = process.env.AGENT_MODEL?.trim() || "claude-opus-4-8";

export function claudeStatus(): IntegrationStatus {
  const live = has("ANTHROPIC_API_KEY");
  return {
    key: "claude",
    label: "Claude (agent reasoning)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live — real ${AGENT_MODEL} calls with adaptive thinking and tool use.`
      : "Sandbox — deterministic planner runs the same tools, approvals and memory without an API key.",
  };
}

export function convexStatus(): IntegrationStatus {
  const live = has("NEXT_PUBLIC_CONVEX_URL");
  return {
    key: "convex",
    label: "Convex (backend)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — memory, events and tasks persisted in Convex."
      : "Sandbox — in-process store (resets when the server restarts).",
  };
}

export function cartesiaStatus(): IntegrationStatus {
  const live = has("CARTESIA_API_KEY");
  return {
    key: "cartesia",
    label: "Cartesia (voice)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — Cartesia text-to-speech."
      : "Sandbox — browser SpeechSynthesis / SpeechRecognition fallback.",
  };
}

export function auth0Status(): IntegrationStatus {
  const live = has("AUTH0_DOMAIN") && has("AUTH0_CLIENT_ID");
  return {
    key: "auth0",
    label: "Auth0 (authentication)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — Auth0 session."
      : "Sandbox — single demo user (no sign-in required).",
  };
}

export function jiraStatus(): IntegrationStatus {
  const live = has("ATLASSIAN_SITE") && has("ATLASSIAN_EMAIL") && has("ATLASSIAN_API_TOKEN") && has("ATLASSIAN_PROJECT_KEY");
  return {
    key: "jira",
    label: "Atlassian Jira (controlled actions)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — sensitive actions mirror to Jira issues for human review."
      : "Sandbox — work items use a local reviewable store with the same interface and dashboard.",
  };
}

export function armadinStatus(): IntegrationStatus {
  const live = has("ARMADIN_API_KEY");
  return {
    key: "armadin",
    label: "Armadin (adversarial testing)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? "Live — Armadin adversarial API."
      : "Unavailable — the red-team suite (npm run redteam) runs locally against Guardian; no Armadin API is used.",
  };
}

export function mossStatus(): IntegrationStatus {
  const live = has("MOSS_API_KEY");
  return {
    key: "moss",
    label: "Moss (personal memory)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? "Live — Moss memory provider."
      : "Unavailable — long-term memory is served by the Convex/in-process store instead.",
  };
}

export function allIntegrationStatuses(): IntegrationStatus[] {
  return [
    claudeStatus(),
    convexStatus(),
    cartesiaStatus(),
    auth0Status(),
    jiraStatus(),
    armadinStatus(),
    mossStatus(),
  ];
}

export function isClaudeLive(): boolean {
  return claudeStatus().mode === "live";
}

export function isConvexLive(): boolean {
  return convexStatus().mode === "live";
}
