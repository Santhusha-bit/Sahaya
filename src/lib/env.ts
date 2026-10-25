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

/** Adaptive thinking is on unless AGENT_THINKING is set to "off" (or "disabled"/"false"). */
export function isThinkingEnabled(): boolean {
  const v = process.env.AGENT_THINKING?.trim().toLowerCase();
  return !(v === "off" || v === "disabled" || v === "false" || v === "0");
}
export const AGENT_BITDEER_MODEL = process.env.BITDEER_MODEL?.trim() || "deepseek-ai/DeepSeek-V4-Flash";
export const AGENT_GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";

export function claudeStatus(): IntegrationStatus {
  const live = has("ANTHROPIC_API_KEY");
  return {
    key: "claude",
    label: "Claude (agent reasoning)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live — real ${AGENT_MODEL} calls with ${isThinkingEnabled() ? "adaptive thinking" : "thinking off (AGENT_THINKING=off)"} and tool use.`
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
      ? "Live: Cartesia sonic-3 voices replies and call warnings; ink-whisper streaming STT transcribes calls."
      : "Sandbox: browser SpeechSynthesis / SpeechRecognition fallback.",
  };
}

/**
 * Auth0 is live only when every value the SDK needs to run the login flow is set.
 * APP_BASE_URL is optional: the SDK falls back to the request host.
 */
export function isAuth0Configured(): boolean {
  return has("AUTH0_DOMAIN") && has("AUTH0_CLIENT_ID") && has("AUTH0_CLIENT_SECRET") && has("AUTH0_SECRET");
}

export function auth0Status(): IntegrationStatus {
  const live = isAuth0Configured();
  return {
    key: "auth0",
    label: "Auth0 (authentication)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: sign-in required; every page and API call runs as the signed-in Auth0 user (/auth/login, /auth/logout)."
      : "Sandbox: single demo user (no sign-in required). Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_SECRET to require sign-in.",
  };
}

export function callScreeningStatus(): IntegrationStatus {
  const live = has("ANTHROPIC_API_KEY");
  return {
    key: "webrtc-calls",
    label: "WebRTC + Claude (scam-call screening)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live: in-app WebRTC calls; Claude (${AGENT_MODEL}) screens the caller's live transcript (Cartesia STT when configured) and Guardian warns privately.`
      : "Sandbox: in-app WebRTC calls are screened by the deterministic scam rules only (no ANTHROPIC_API_KEY).",
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

export function geminiStatus(): IntegrationStatus {
  const live = has("GEMINI_API_KEY");
  return {
    key: "gemini",
    label: "Gemini (pantry photo vision)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live: Care sends pantry/fridge photos to ${AGENT_GEMINI_MODEL} to propose ingredients. Output is schema-validated in code; uncertain items are confirmed with the person before meal planning.`
      : "Sandbox: a fixed sample fridge detection stands in for Gemini (the photo is not analyzed); the same validation, confirmation and meal planning apply.",
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
      ? "Live: consented, de-identified household data is summarized in Snowflake (monthly family care report)."
      : "Sandbox: household aggregates and the monthly care summary are computed locally with the same interface; nothing leaves the device.",
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

export function apifyGroceryStatus(): IntegrationStatus {
  const forced = process.env.GROCERY_DISCOVERY_MODE?.trim().toLowerCase();
  const live = has("APIFY_TOKEN") && has("APIFY_GROCERY_ACTOR_ID") && forced !== "local" && forced !== "sandbox";
  const actor = process.env.APIFY_GROCERY_ACTOR_ID?.trim();
  return {
    key: "apify-grocery",
    label: "Apify (live grocery product discovery)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live: Care runs the ${actor} Actor on Apify for each shopping list and reads its dataset (names, prices, availability, source URLs).`
      : forced === "sandbox"
        ? "Sandbox: an offline fixture catalog with the same ranking code stands in for the Actor."
        : "Sandbox: no APIFY_TOKEN, so the Actor's discovery code runs in-process against Open Prices (real prices, but not an Apify run).",
  };
}

export function brightDataStatus(): IntegrationStatus {
  const live = has("BRIGHTDATA_API_TOKEN") && has("BRIGHTDATA_SERP_ZONE");
  return {
    key: "brightdata",
    label: "Bright Data (public price verification)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: Care cross-checks a product against current public Google Shopping listings via the Bright Data SERP API. Results are validated and normalized in code."
      : "Sandbox: labeled sample listings with the same interface exercise validation, unit-price comparison and freshness. Not live prices.",
  };
}

export function x402Status(): IntegrationStatus {
  const wallet = /^0x[0-9a-fA-F]{64}$/.test(process.env.X402_WALLET_PRIVATE_KEY?.trim() ?? "");
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(process.env.X402_PAY_TO?.trim() ?? "");
  const live = wallet && payTo;
  const missing = !wallet && !payTo ? "no test wallet or payee configured" : !wallet ? "no test wallet (X402_WALLET_PRIVATE_KEY)" : "no payee (X402_PAY_TO)";
  return {
    key: "x402",
    label: "Coinbase x402 (paid agent services)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? `Live (testnet): Care pays for product data in Base Sepolia test USDC; the service verifies and settles through the x402 facilitator (${process.env.X402_FACILITATOR_URL?.trim() || "https://x402.org/facilitator"}). Mainnet is refused in code.`
      : `Sandbox: ${missing}. Care signs real x402 payment authorizations with a throwaway key and a local verifier checks them; nothing settles and no funds move.`,
  };
}

export function nessieStatus(): IntegrationStatus {
  const live = has("NESSIE_API_KEY");
  return {
    key: "nessie",
    label: "Capital One Nessie (sandbox bank data)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: Finance reads purchases from a real Capital One Nessie sandbox account (fake money, real API)."
      : "Sandbox: a local emulator with the same Nessie API shapes holds the test account (set NESSIE_API_KEY for the real Nessie API).",
  };
}

export function crsStatus(): IntegrationStatus {
  const live = (has("CRS_USERNAME") || has("CRS_USER")) && (has("CRS_PASSWORD") || has("CRS_PASS"));
  return {
    key: "crs",
    label: "CRS Credit API (credit + identity review)",
    mode: live ? "live" : "sandbox",
    detail: live
      ? "Live: Finance sends real requests to the CRS sandbox API (TransUnion credit report, TransUnion identity verification, AtData FraudFinder) for a CRS test identity only. No bank transaction monitoring."
      : "Sandbox: no CRS credentials, so Finance uses an offline fixture shaped like a recorded CRS sandbox response for test persona P13. No CRS call is made. Set CRS_USERNAME/CRS_PASSWORD for real sandbox requests.",
  };
}

export function disputeChannelStatus(): IntegrationStatus {
  return {
    key: "dispute-channel",
    label: "Billing office (dispute submission)",
    mode: "sandbox",
    detail:
      "Sandbox: hospitals expose no public billing-dispute API, so approved letters go to a simulated billing office that acknowledges, reviews and responds on a demo-paced timeline. Nothing is sent outside the app.",
  };
}

export function factoryDroidStatus(): IntegrationStatus {
  const live = has("FACTORY_API_KEY");
  return {
    key: "factory-droid",
    label: "Factory Droid SDK (bill investigations)",
    mode: live ? "live" : "unavailable",
    detail: live
      ? "Live: Finance hands bill investigations to a separate Droid run with only read-only calculation tools and the authorized documents."
      : "Unavailable: no FACTORY_API_KEY, so Droid does not run. Investigations use Finance's local calculation engine instead and are labeled as such.",
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
    armadinStatus(),
    mossStatus(),
    bitdeerStatus(),
    geminiStatus(),
    backboardStatus(),
    tigerDataStatus(),
    snowflakeStatus(),
    apifyStatus(),
    apifyGroceryStatus(),
    checkoutStatus(),
    brightDataStatus(),
    x402Status(),
    nessieStatus(),
    crsStatus(),
    disputeChannelStatus(),
    factoryDroidStatus(),
  ];
}

/** Integrations most relevant to Care's pantry-to-dinner flow. */
export function pantryIntegrationStatuses(): IntegrationStatus[] {
  return [geminiStatus(), claudeStatus(), convexStatus()];
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
