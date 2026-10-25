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
export const AGENT_BITDEER_MODEL = process.env.BITDEER_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Flash";

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

export function twilioStatus(): IntegrationStatus {
  const live = has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN");
  return {
    key: "twilio",
    label: "Twilio Voice (scam-call demo)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? "Live — callers dial the Twilio number; Guardian screens the transcript and speaks the warning."
      : "Unavailable — no Twilio credentials; use the in-app voice mic to demo scam-call detection.",
  };
}

export function fetchaiStatus(): IntegrationStatus {
  const live = has("FETCHAI_BRIDGE_URL");
  return {
    key: "fetchai",
    label: "Fetch.ai uAgents (agent messaging)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? "Live — typed messages exchanged with the Python uAgents bridge over local HTTP."
      : "Unavailable — Python/uAgents bridge not configured; agent-to-agent messaging runs on the in-process bus (not labeled Fetch.ai).",
  };
}

export function elasticStatus(): IntegrationStatus {
  const live = has("ELASTIC_URL") && has("ELASTIC_API_KEY");
  return {
    key: "elastic",
    label: "Elasticsearch (incident search)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — incidents indexed in Elasticsearch for semantic/keyword search."
      : "Sandbox — a local in-memory index with the same interface powers incident search.",
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
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — Moss personal-memory provider stores Wellness continuity context."
      : "Sandbox — Wellness continuity memory is served by the Convex/in-process store with the same interface.",
  };
}

export function bitdeerStatus(): IntegrationStatus {
  const live = has("BITDEER_API_KEY");
  return {
    key: "bitdeer",
    label: "Bitdeer AI Model Studio (observation extraction)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live — structured wellness-observation extraction via Bitdeer (${AGENT_BITDEER_MODEL}). Output is schema-validated and evidence-checked in code before use.`
      : "Sandbox — a deterministic offline extractor with the same interface proposes observations; the same strict validation + evidence grounding applies.",
  };
}

export function backboardStatus(): IntegrationStatus {
  const live = has("BACKBOARD_API_KEY");
  return {
    key: "backboard",
    label: "Backboard (long-term conversational context)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: consented hobbies / family-visit facts indexed in a per-user Backboard assistant; every hit is re-verified against Convex (version, timestamps, consent) before use."
      : "Sandbox: an in-process index with the same interface; the same Convex re-verification of every hit applies.",
  };
}

export function tigerDataStatus(): IntegrationStatus {
  const live = has("TIGERDATA_URL") && has("TIGERDATA_API_KEY");
  return {
    key: "tigerdata",
    label: "Tiger Data (wellness time series)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — sleep/energy time series stored and trended in Tiger Data (TimescaleDB)."
      : "Sandbox — a local time-series store with the same interface computes longitudinal trends.",
  };
}

export function snowflakeStatus(): IntegrationStatus {
  const live = has("SNOWFLAKE_ACCOUNT") && has("SNOWFLAKE_TOKEN");
  return {
    key: "snowflake",
    label: "Snowflake (household analytics)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live — authorized, consented household aggregates are available to Snowflake."
      : "Sandbox — authorized household aggregates are computed locally with the same interface; nothing leaves the device.",
  };
}

export function allIntegrationStatuses(): IntegrationStatus[] {
  return [
    claudeStatus(),
    convexStatus(),
    cartesiaStatus(),
    auth0Status(),
    jiraStatus(),
    elasticStatus(),
    fetchaiStatus(),
    twilioStatus(),
    armadinStatus(),
    mossStatus(),
    bitdeerStatus(),
    backboardStatus(),
    tigerDataStatus(),
    snowflakeStatus(),
  ];
}

/** Integrations most relevant to the Wellness agent, for its dashboard. */
export function wellnessIntegrationStatuses(): IntegrationStatus[] {
  return [
    claudeStatus(),
    bitdeerStatus(),
    convexStatus(),
    mossStatus(),
    backboardStatus(),
    tigerDataStatus(),
    snowflakeStatus(),
  ];
}

export function isClaudeLive(): boolean {
  return claudeStatus().mode === "live";
}

export function isConvexLive(): boolean {
  return convexStatus().mode === "live";
}
