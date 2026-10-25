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

export function callScreeningStatus(): IntegrationStatus {
  const live = has("ANTHROPIC_API_KEY");
  return {
    key: "webrtc-calls",
    label: "WebRTC + Claude (scam-call screening)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live: in-app WebRTC calls; Claude (${AGENT_MODEL}) screens the caller's live transcript and Guardian warns privately.`
      : "Sandbox: in-app WebRTC calls are screened by the deterministic scam rules only (no ANTHROPIC_API_KEY).",
  };
}

export function twilioStatus(): IntegrationStatus {
  const live = has("TWILIO_ACCOUNT_SID") && has("TWILIO_AUTH_TOKEN");
  return {
    key: "twilio",
    label: "Twilio SMS (caregiver alerts)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: Guardian alerts and Care reminders are texted to trusted contacts."
      : "Sandbox: no Twilio credentials; alerts are recorded in-app and nothing is texted.",
  };
}

export function fetchaiStatus(): IntegrationStatus {
  const agents = ["wellness", "care", "finance"].filter(
    (a) => has(`FETCHAI_${a.toUpperCase()}_URL`) || (a === "wellness" && has("FETCHAI_BRIDGE_URL")),
  );
  const live = agents.length > 0;
  return {
    key: "fetchai",
    label: "Fetch.ai uAgents (agent messaging)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? `Live: ${agents.join(", ")} -> Guardian requests travel as signed uAgents messages between independent agent processes.`
      : "Unavailable: no uAgent URL configured; agent-to-agent messaging runs on the in-process bus (not labeled Fetch.ai).",
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
  const live = has("MOSS_PROJECT_ID") && (has("MOSS_PROJECT_KEY") || has("MOSS_API_KEY")) && has("MOSS_INDEX_NAME");
  return {
    key: "moss",
    label: "Moss (continuity retrieval)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Configured: minimized, consented continuity cues sync to Moss index "${process.env.MOSS_INDEX_NAME?.trim()}" (control-plane REST). Convex stays canonical; run npm run moss:verify to confirm the credentials and index.`
      : "Sandbox: continuity cues are kept in an in-process index with the same semantics; Convex holds the canonical ledger. Set MOSS_PROJECT_ID, MOSS_PROJECT_KEY and MOSS_INDEX_NAME to go live.",
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

/**
 * Tiger Data is TimescaleDB on PostgreSQL, so "configured" means a postgres://
 * service URL. TIGERDATA_SERVICE_URL is preferred; TIMESCALE_SERVICE_URL and a
 * postgres:// TIGERDATA_URL are accepted for older env files.
 */
export function tigerDataServiceUrl(): string | null {
  const candidates = [process.env.TIGERDATA_SERVICE_URL, process.env.TIMESCALE_SERVICE_URL, process.env.TIGERDATA_URL];
  return candidates.map((v) => v?.trim()).find((v) => !!v && /^postgres(ql)?:\/\//.test(v)) ?? null;
}

export function tigerDataStatus(): IntegrationStatus {
  const live = tigerDataServiceUrl() !== null;
  return {
    key: "tigerdata",
    label: "Tiger Data (wellness time series)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: approved sleep/energy observations are mirrored into a Tiger Data hypertable; weekly and monthly trends are computed with time_bucket."
      : "Sandbox: an in-process time-series store with the same interface computes the same weekly and monthly aggregates.",
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

export function apifyStatus(): IntegrationStatus {
  const live = has("APIFY_TOKEN");
  return {
    key: "apify",
    label: "Apify (product search)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live: Care searches real product listings by running the ${process.env.APIFY_ACTOR_ID?.trim() || "apify~e-commerce-scraping-tool"} Actor. Any item the live search cannot find falls back to the sandbox catalog and is labeled as such.`
      : "Sandbox: Care searches a local store catalog with the same interface (set APIFY_TOKEN for live product search).",
  };
}

export function checkoutStatus(): IntegrationStatus {
  return {
    key: "checkout",
    label: "Checkout + order tracking",
    mode: "sandbox",
    detail:
      "Sandbox: the shopping demo ends at a sandbox checkout charged to a saved Visa test card reference (no card number is stored, no money moves). Tracking runs on a demo-paced timeline.",
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
    callScreeningStatus(),
    twilioStatus(),
    armadinStatus(),
    mossStatus(),
    bitdeerStatus(),
    backboardStatus(),
    tigerDataStatus(),
    snowflakeStatus(),
    apifyStatus(),
    checkoutStatus(),
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
