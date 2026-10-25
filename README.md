# Sahaya

Sahaya is a voice-first companion app for older adults and the families who look
after them. Instead of one chatbot, it runs four separate AI agents (Guardian, Care,
Wellness and Finance), each with its own prompt, tools, scoped memory and approval
policy. Agents read, compare and propose; anything sensitive (alerting family,
placing an order, sending a dispute letter, reading a bank account) waits for a
person to approve it, and that rule is enforced in code, not in a prompt.

- Live app: https://sahaya-mu.vercel.app
- Landing page: https://sahaya-landing-pink.vercel.app (source in [`landing/`](landing/))

Every external service is optional. With no keys at all, the app runs in sandbox
mode: the same tools, approvals, memory and event bus run against local stand-ins,
and each integration is labeled `live`, `sandbox` or `unavailable` on the Profile
page and at `/api/status`.

## Contents

- [The four agents](#the-four-agents)
- [Architecture](#architecture)
- [How we use each service](#how-we-use-each-service)
- [Safety design](#safety-design)
- [Getting started](#getting-started)
- [Deployment](#deployment)

## The four agents

| Agent | What it does | Main screens |
|---|---|---|
| **Guardian** | Scam protection. Screens messages and live calls for scam tactics, verifies callers, alerts trusted contacts, answers "has someone tried this scam before?" from the person's own incident history, and coordinates help requests from the other agents. | `/agents/guardian`, `/call`, `/approvals` |
| **Care** | Groceries, meals and shopping. Builds carts from order history and preferences, discovers and price-checks products, turns a fridge photo into a dinner plan, and ends at a sandbox checkout that needs the person's approval. | `/agents/care`, `/shop`, `/groceries`, `/care/pantry` |
| **Wellness** | Daily check-ins, mood/sleep/social observations, continuity between conversations ("how was your granddaughter's visit?"), weekly and monthly trends, and a consented family care report. Never gives medical advice. | `/agents/wellness`, `/wellness` |
| **Finance** | Spending review on a sandbox bank account, credit and identity review, and medical bill investigation (bill vs. insurance EOB) that drafts a dispute letter for approval. Never moves money. | `/agents/finance`, `/money`, `/finance/case`, `/finance/investigate` |

Agents never read each other's private memory. They cooperate only through a
permission-checked event bus (for example Wellness -> Guardian for a safety concern,
Care -> Finance for a payment review), and only for workflows the person consented to.

## Architecture

```
src/app/                Next.js 15 App Router: PWA pages + /api routes
src/agents/
  base/                 BaseAgent runtime, ToolRegistry, ScopedMemory, AgentEventBus,
                        policy.ts (all authorization), approvals, workItems (code gate),
                        audit log, dataLayer (Convex or in-process)
  guardian/ care/ wellness/ finance/
                        each agent: <Agent>.ts + prompt + tools + workflows
  registry.ts service.ts consent.ts
src/integrations/       one adapter per external service, each with a sandbox twin
src/analytics/          household / family care report exports (Snowflake)
src/redteam/            adversarial suites for Guardian and Wellness
src/lib/env.ts          the single source of truth for live/sandbox/unavailable status
convex/                 schema + functions (memories, events, tasks, approvals, conversations)
services/uagents/       Python Fetch.ai uAgents, one process per agent
actors/                 Apify Actor source (grocery product discovery)
landing/                marketing site (separate Vercel project)
scripts/                terminal demos and red-team runners
```

- **Agent runtime.** `BaseAgent` handles messages and voice input, plans with Claude
  (or a deterministic planner in sandbox), and executes zod-validated tools from that
  agent's own registry.
- **Approval gate.** Tools flagged `requiresApproval` do not run; the runtime records
  an approval and returns `awaiting_approval`. Approval is bound to the exact payload
  (cart hash and total, letter fingerprint and recipient, quote), so a changed request
  needs a new approval.
- **Work items and audit.** Cross-agent and high-risk actions become work items whose
  history is a SHA-256 hash chain. The code gate checks reviewer role, dual control
  for high-risk actions, input hash, expiry and single use before anything executes.
- **Data layer.** Convex is the canonical store for memory, events, tasks, approvals
  and conversations. Without Convex the same interface runs in process memory.
- **Agent processes.** With Fetch.ai configured, Wellness, Care, Finance and Guardian
  each also run as their own Python uAgent and exchange signed messages; the
  TypeScript agents remain the decision makers.

## How we use each service

Each service has an adapter in `src/integrations/` and a status function in
`src/lib/env.ts`. "Without keys" describes exactly what the code does when the env
vars are missing.

### Platform (all agents)

#### Claude (Anthropic)
- **What it does:** the reasoning model for all four agents: conversation, planning
  and tool use (default model `claude-opus-4-8`, adaptive thinking on unless
  `AGENT_THINKING=off`). It is also used for specific advisory jobs whose output code
  validates before use: screening live call transcripts (Guardian), summarizing past
  scam incidents (Guardian), categorizing bank transactions (Finance), explaining
  credit findings (Finance), and comparing bill and EOB documents (Finance).
- **Files:** `src/lib/llm.ts`, `src/agents/base/BaseAgent.ts`,
  `src/integrations/callScreening.ts`, `src/agents/guardian/incidentSummary.ts`,
  `src/agents/finance/nessie/classify.ts`, `src/agents/finance/credit/creditReview.ts`,
  `src/agents/finance/investigation/analyst.ts`
- **Env:** `ANTHROPIC_API_KEY`, optional `AGENT_MODEL`, `AGENT_THINKING`, `AGENT_MAX_TOKENS`
- **Without keys:** a deterministic per-agent planner drives the same tools, approvals
  and memory. Call screening uses only the deterministic scam rules, and summaries and
  explanations fall back to code templates.

#### Convex
- **What it does:** the primary backend. Stores each agent's scoped memories, the
  cross-agent event log, tasks, approvals and conversations. It is the canonical
  record that Moss, Backboard, Tiger Data and Snowflake are checked against.
- **Files:** `convex/`, `src/agents/base/dataLayer.ts`
- **Env:** `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_DEPLOYMENT` (run `npm run convex:dev`)
- **Without keys:** an in-process store with the same interface (data resets when the
  server restarts).

#### Cartesia (voice)
- **What it does:** `sonic-3` text-to-speech for agent replies (Care, Wellness) and for
  Guardian's private call warnings; `ink-whisper` streaming speech-to-text for the
  caller's audio in screened calls. Browsers receive a short-lived, STT-only token from
  `/api/voice/stt-token`; the API key never leaves the server.
- **Files:** `src/integrations/cartesia.ts`, `src/lib/cartesiaStt.ts`,
  `src/app/api/voice/`
- **Env:** `CARTESIA_API_KEY`, optional `CARTESIA_VOICE_ID`, `CARTESIA_CALLER_VOICE_ID`
- **Without keys:** the browser's built-in SpeechSynthesis and SpeechRecognition.

#### Auth0 (authentication)
- **What it does:** sign-in for the person or caregiver using `@auth0/nextjs-auth0` v4:
  login at `/auth/login`, callback at `/auth/callback`, logout at `/auth/logout`. Agents
  act for the signed-in user, and Wellness and Finance can report whether they are
  acting for a verified Auth0 session or the demo user.
- **Files:** `src/lib/user.ts`, `src/lib/env.ts` (`auth0Status`)
- **Env:** `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`,
  `APP_BASE_URL`
- **Without keys:** single-user demo mode with a fixed demo user and no sign-in.

#### Fetch.ai uAgents (agent-to-agent messaging)
- **What it does:** Wellness, Care and Finance each have their own Python uAgent, and
  Guardian has one too, each a separate OS process with its own identity. A help
  request (for example Wellness asking Guardian to coordinate grocery help) travels
  as a signed uAgents envelope between processes; the Guardian uAgent verifies the
  sender and forwards to the app's Guardian intake, and the task id and status ride
  back the same way. Only the minimum data crosses (need, urgency, consent reference).
- **Files:** `src/integrations/fetchai.ts`, `services/uagents/`,
  `src/app/api/bridge/guardian/assistance/route.ts`, `src/app/api/bridge/logs/route.ts`
- **Env:** `FETCHAI_WELLNESS_URL`, `FETCHAI_CARE_URL`, `FETCHAI_FINANCE_URL`
  (`FETCHAI_BRIDGE_URL` is the legacy Wellness name), `FETCHAI_GUARDIAN_URL`,
  `SAHAYA_BRIDGE_TOKEN` (shared secret, required in production)
- **Without keys:** the identical exchange runs on the in-process event bus and Fetch.ai
  is labeled `unavailable`. A configured but unreachable uAgent is reported as a
  rejection, not silently swapped for the in-process path.

#### Atlassian Jira (controlled actions)
- **What it does:** sensitive and cross-agent actions (for example Guardian delegating
  work to Finance) become work items that mirror to Jira issues as the human review
  surface, with two-way status sync. A Jira status alone never authorizes execution:
  the code gate in `workItems.ts` still checks the hash-chained history, reviewer roles,
  dual control, input hash, expiry and single use. A Jira transition only counts if the
  Jira account is bound to a known reviewer.
- **Files:** `src/integrations/jira.ts`, `src/agents/base/workItems.ts`,
  `src/agents/base/workItemPolicy.ts`, `src/app/api/work-items/route.ts`, `/approvals`
- **Env:** `ATLASSIAN_SITE`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`,
  `ATLASSIAN_PROJECT_KEY`, optional `ATLASSIAN_REVIEWER_ACCOUNTS`,
  `ATLASSIAN_APPROVE_STATUSES`, `ATLASSIAN_REJECT_STATUSES`
- **Without keys:** a local work-item store with the same interface and dashboard. The
  execution gate is enforced the same way.

### Guardian (scam protection)

#### WebRTC + Claude (scam-call screening)
- **What it does:** in-app calls at `/call` run peer to peer over WebRTC (the server only
  relays the SDP offer and answer). The protected person's browser transcribes the
  caller's audio (Cartesia STT when configured) and sends the rolling transcript to
  `/api/voice/call/[room]/screen`. Claude and the deterministic scam-signal detector
  both read it; once the combined risk is high, the full Guardian workflow runs once per
  call: the policy decides, the incident is recorded, caregivers are alerted, and
  Guardian warns the person privately. "Play demo scam call" simulates a fictional
  grandson asking for gift cards.
- **Files:** `src/integrations/webrtc.ts`, `src/integrations/callScreening.ts`,
  `src/app/api/voice/call/`, `src/app/call/page.tsx`
- **Env:** uses `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY`; optional `WEBRTC_ICE_SERVERS`
  (JSON `RTCIceServer[]`, defaults to Google public STUN)
- **Without keys:** calls are screened by the deterministic scam rules only. Call rooms
  live in process memory, so both peers must reach the same server instance.

#### Elasticsearch (incident search)
- **What it does:** after each scam incident is saved, an indexing job writes a
  PII-redacted, field-allowlisted projection to Elasticsearch so the person (and
  authorized caregivers) can ask "has someone tried this scam before?". Search is
  full-text over the redacted text and tactics plus boosted matches on scam signals,
  always filtered to the caller's own user id. Claude writes the plain-language answer,
  but code rejects a draft that cites unknown incidents, misses the top match, or
  claims it was the "same caller".
- **Files:** `src/integrations/search.ts`, `src/agents/guardian/incidentIndexer.ts`,
  `src/agents/guardian/incidentSummary.ts`
- **Env:** `ELASTIC_URL`, `ELASTIC_API_KEY`, optional `ELASTIC_INDEX`
- **Without keys:** a local in-memory index with the same interface.

#### Armadin (adversarial testing)
- **What it does:** reserved for an external adversarial-testing API. No Armadin API
  calls exist in the code today; adversarial testing is done by Sahaya's own red-team
  suites (`npm run redteam`, `npm run redteam:wellness`).
- **Files:** `src/lib/env.ts` (`armadinStatus`), `src/redteam/`
- **Env:** `ARMADIN_API_KEY`
- **Without keys:** labeled `unavailable`; the local red-team suites run either way.

### Care (groceries, meals, shopping)

#### Apify (product search for voice shopping)
- **What it does:** on `/shop`, after Care works out the person's usual items, it
  searches real product listings by running an Apify Actor (default
  `apify~e-commerce-scraping-tool`, keyword search) and normalizes the results for
  Care's substitution policy and cart.
- **Files:** `src/integrations/apify.ts`, `src/agents/care/shopping/service.ts`
- **Env:** `APIFY_TOKEN`, optional `APIFY_ACTOR_ID`, `APIFY_MARKETPLACES`, `APIFY_TIMEOUT_MS`
- **Without keys:** a local store catalog with the same interface. When live, any item
  the search cannot find falls back to the catalog for that item only and is labeled.

#### Apify (live grocery product discovery)
- **What it does:** on `/groceries`, Care sends a shopping list to our own Grocery
  Product Discovery Actor (source in `actors/grocery-product-discovery`) and reads back
  normalized offers: names, prices, availability and source URLs. The run id and Apify
  Console link are shown as proof of a real run. All returned data is treated as
  untrusted: schema-validated, sanitized, URL-restricted and price-bounded before any
  agent or model sees it.
- **Files:** `src/integrations/apifyGrocery.ts`, `src/agents/care/groceryWorkflow.ts`,
  `actors/grocery-product-discovery/`
- **Env:** `APIFY_TOKEN`, `APIFY_GROCERY_ACTOR_ID`, optional `GROCERY_DISCOVERY_MODE`
  (`local` or `sandbox`)
- **Without keys:** the Actor's own discovery code runs in-process against Open Prices
  (real prices, but not an Apify run, and labeled `sandbox`). `GROCERY_DISCOVERY_MODE=sandbox`
  uses an offline fixture catalog.

#### Bright Data (public price verification)
- **What it does:** Apify discovers a product; Bright Data verifies its price. Care sends
  only the product name to Google Shopping through the Bright Data SERP API, then
  validates every listing in code (USD only, http(s) links, injected instructions
  dropped), normalizes sizes to a unit price, flags suspiciously cheap listings, marks
  results older than 24 hours as stale, and reports whether the usual price is fair.
  A chosen listing only goes into a draft cart; buying still needs approval.
- **Files:** `src/integrations/brightdata.ts`, `src/agents/care/priceCompare.ts`
- **Env:** `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_SERP_ZONE`
- **Without keys:** clearly labeled sample listings with the same interface (not live prices).

#### Visa checkout + order tracking (sandbox)
- **What it does:** the end of the `/shop` voice flow. The person taps "Approve and pay";
  the approval is bound to the cart id, hash and total, and checkout refuses a changed,
  superseded, already-ordered or over-limit cart. A spoken "yes" never approves. The
  checkout uses a saved Visa test card reference (no card number is stored) and
  returns a sandbox order with a placed, packed, out for delivery, delivered timeline.
- **Files:** `src/integrations/checkout.ts`, `src/agents/care/shopping/`
- **Env:** optional `SHOP_TRACKING_STEP_MS` (tracking pace)
- **Without keys:** this integration is always sandbox. No money moves.

#### Google Gemini (pantry photo vision)
- **What it does:** on `/care/pantry`, the person photographs their fridge or pantry
  (downscaled in the browser, never stored). Gemini's only job is to propose visible
  ingredients. Code validates the result, holds back items under 75% confidence, rejects
  text read off notes or labels, and makes the person confirm uncertain items before the
  deterministic meal planner proposes a recipe and a list of missing items.
- **Files:** `src/integrations/gemini.ts`, `src/agents/care/pantryPolicy.ts`,
  `src/agents/care/mealPlanner.ts`, `src/app/api/care/pantry/route.ts`
- **Env:** `GEMINI_API_KEY`, optional `GEMINI_MODEL` (default `gemini-3.8-flash`),
  `GEMINI_BASE_URL`
- **Without keys:** a fixed sample fridge detection (the photo is not analyzed); the same
  validation, confirmation and planning apply.

#### Coinbase x402 (paid agent services)
- **What it does:** Care can buy product-comparison data from a paid service at
  `/api/x402/product-compare` using the x402 protocol (HTTP 402 Payment Required). Care
  signs an EIP-3009 USDC authorization and the service verifies and settles it through
  the x402 facilitator, in Base Sepolia test USDC only; mainnet is refused in code. An
  optional experiment (`FINANCE_X402_REPORTS=on`) lets Finance buy benchmark reports
  from `/api/x402/financial-report`, always in sandbox and only after approving the
  exact quote.
- **Files:** `src/integrations/x402.ts`, `src/agents/care/paidServices/`,
  `src/agents/finance/paidReports/`, `src/app/api/x402/`
- **Env:** `X402_WALLET_PRIVATE_KEY` (a testnet wallet only), `X402_PAY_TO`, optional
  `X402_FACILITATOR_URL`, `X402_SERVICE_URL`, `FINANCE_X402_REPORTS`
- **Without keys:** a throwaway key signs the same authorizations and a local verifier
  checks signature, payee, amount, time window and nonce. Nothing settles and no funds move.

### Wellness (check-ins, memory, trends)

#### Bitdeer AI Model Studio (observation extraction)
- **What it does:** extracts structured wellness observations (mood, sleep, social
  contact) from privacy-minimized check-in text through Bitdeer's OpenAI-compatible
  inference API. The model is advisory: output is schema-validated and every
  observation must be grounded in evidence from the text before it is used.
- **Files:** `src/integrations/bitdeer.ts`, `src/agents/wellness/extractObservations.ts`
- **Env:** `BITDEER_API_KEY`, optional `BITDEER_MODEL` (default
  `deepseek-ai/DeepSeek-V4-Flash`), `BITDEER_BASE_URL`, `BITDEER_THINKING`
- **Without keys:** a deterministic offline extractor with the same interface, under
  the same validation.

#### Moss (continuity retrieval)
- **What it does:** holds short, minimized, consented continuity cues derived from
  accepted observations ("how she has been"), keyed by opaque ids and a pseudonymous
  subject, so Wellness can follow up across conversations. Convex stays canonical, and
  Wellness only asks Moss for document ids that Convex says belong to the user. Never
  receives raw conversation text.
- **Files:** `src/integrations/moss.ts`, `src/agents/wellness/continuityMemory.ts`
- **Env:** `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY` (or `MOSS_API_KEY`), `MOSS_INDEX_NAME`,
  `MOSS_SUBJECT_SALT` (set in production). Check with `npm run moss:verify`.
- **Without keys:** an in-process index with the same semantics.

#### Backboard (long-term conversational context)
- **What it does:** indexes life-context facts the person chose to share (hobbies,
  family visits, plans) in a separate Backboard assistant per user, so Wellness can pick
  up a thread days later. Backboard is treated as untrusted: every hit is re-verified
  against the Convex record (version, timestamps, consent) before use. No transcripts,
  no health observations.
- **Files:** `src/integrations/backboard.ts`, `src/agents/wellness/conversationContext.ts`
- **Env:** `BACKBOARD_API_KEY`, optional `BACKBOARD_BASE_URL`
- **Without keys:** an in-process index with the same interface and the same re-verification.

#### Tiger Data (wellness time series)
- **What it does:** a sync job mirrors approved numeric observations (sleep, energy) into
  a TimescaleDB hypertable on Tiger Data; weekly and monthly trends are computed in the
  database with `time_bucket` and shown on `/wellness`. Points are keyed by the canonical
  observation id, so re-syncs are idempotent and deletions and corrections propagate.
- **Files:** `src/integrations/tigerdata.ts`, `src/agents/wellness/timeSeriesSync.ts`,
  `src/agents/wellness/longitudinalTrends.ts`, `src/app/api/wellness/trends/route.ts`
- **Env:** `TIGERDATA_SERVICE_URL` (a `postgres://` URL; `TIMESCALE_SERVICE_URL` and a
  `postgres://` `TIGERDATA_URL` are also accepted)
- **Without keys:** an in-process time-series store computing the same aggregates.

#### Snowflake (household analytics and family care report)
- **What it does:** receives only de-identified household data: numeric Wellness
  aggregates (`household_analytics`) and consented Care facts reduced to category,
  outcome and day (`household_care_facts`). The monthly family care summary is computed
  in Snowflake with a single `GROUP BY` through the SQL REST API, and Sahaya reads back
  only the aggregate. Every row is schema-checked before export, so an extra field such
  as a name or note is rejected.
- **Files:** `src/integrations/snowflake.ts`, `src/agents/wellness/householdAnalytics.ts`,
  `src/analytics/householdCareExport.ts`, `src/analytics/familyCareReport.ts`,
  `src/app/api/household/report/route.ts`
- **Env:** `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_TOKEN`, optional `SNOWFLAKE_TOKEN_TYPE`,
  `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE`
- **Without keys:** aggregates and the monthly summary are computed locally; nothing
  leaves the device.

### Finance (spending, credit, bills)

#### Capital One Nessie (sandbox bank data)
- **What it does:** on `/money`, Finance asks for read-only access to a checking account
  (an approval card), then reads purchases only from that authorized account. Claude
  categorizes them (labels validated in code), and code finds possible double charges,
  subscriptions and price increases. Suggestions only draft a dispute or add a to-do.
  Only the last four digits of the account are stored, and Finance has no tool that
  creates purchases.
- **Files:** `src/integrations/nessie.ts`, `src/agents/finance/nessie/`,
  `src/app/api/finance/bank/route.ts`
- **Env:** `NESSIE_API_KEY`, optional `NESSIE_BASE_URL`
- **Without keys:** a local emulator that mirrors Nessie's request and response shapes.

#### CRS Credit API (credit and identity review)
- **What it does:** when the person asks Finance for a credit or identity check, and
  after approval and consent, Finance requests a TransUnion credit report, TransUnion
  identity verification and AtData FraudFinder results from the CRS sandbox for the
  linked CRS test identity. Code turns the fields into evidence-backed findings and
  changes since the last review; Claude explains them (validated in code); next steps
  come from a fixed table. Production CRS hosts and non-test SSNs are refused, and the
  SSN is never stored. CRS does not provide bank transaction monitoring.
- **Files:** `src/integrations/crs.ts`, `src/integrations/crsFixtures.ts`,
  `src/agents/finance/credit/`
- **Env:** `CRS_USERNAME`, `CRS_PASSWORD`, optional `CRS_LINKED_PERSONA` (default `P13`),
  `CRS_TEST_PERSONAS`, `CRS_TU_CONFIG`, `CRS_FRAUD_CONFIG`
- **Without keys:** an offline fixture shaped like a recorded CRS sandbox response for
  test persona P13. No CRS call is made.

#### Hyphenate track: bill investigation and sandbox billing office
- **What it does:** on `/finance/case`, the person uploads a hospital statement and an
  insurance EOB (samples in `public/samples/`). Finance extracts both with a deterministic
  parser (every fact keeps its source line and the document's SHA-256), reconciles them
  in code, keeps Claude's flags only when the rules engine agrees, and drafts a dispute
  letter. The person approves the exact letter (bound to case, draft fingerprint and
  recipient), Finance submits it to the billing office, tracks the response and verifies
  the corrected balance. Every step goes into a SHA-256 hash-chained case audit trail
  that can be exported as an evidence packet. Hospitals expose no public dispute API,
  so the billing office is always a simulation.
- **Files:** `src/agents/finance/investigation/`, `src/integrations/billingOffice.ts`
- **Env:** optional `FINANCE_CASE_STEP_MS`, `FINANCE_BILLING_SCENARIO=partial`
- **Without keys:** always sandbox. Nothing is sent outside the app.

#### Factory Droid SDK (bill investigation worker)
- **What it does:** on `/finance/investigate`, Finance hands a bill investigation to a
  separate Droid run. Sahaya, not the model, scopes it: an empty throwaway working
  directory, every built-in Droid tool (shell, files, web) disabled, only Sahaya's
  read-only calculation tools exposed, and the authorized documents attached. Finance
  then checks the Droid's report against its own recomputation before explaining it and
  drafting a dispute that needs approval.
- **Files:** `src/integrations/factoryDroid.ts`, `src/agents/finance/investigation/service.ts`
- **Env:** `FACTORY_API_KEY`, optional `FACTORY_DROID_MODEL`, `FACTORY_DROID_TIMEOUT_MS`,
  `DROID_EXEC_PATH`
- **Without keys:** labeled `unavailable`; the investigation runs on Finance's local
  calculation engine and is labeled as such.

### Summary table

| Service | Agent | Live when set | Without it |
|---|---|---|---|
| Claude | all | `ANTHROPIC_API_KEY` | deterministic planner and rules |
| Convex | all | `NEXT_PUBLIC_CONVEX_URL` | in-process store |
| Cartesia | all (voice), Guardian calls | `CARTESIA_API_KEY` | browser speech APIs |
| Auth0 | all | `AUTH0_DOMAIN` + `AUTH0_CLIENT_ID` (+ secret, `AUTH0_SECRET`, `APP_BASE_URL`) | single demo user |
| Fetch.ai uAgents | Wellness, Care, Finance -> Guardian | `FETCHAI_*_URL` | in-process bus (`unavailable`) |
| Atlassian Jira | Guardian, Care, Finance work items | 4 `ATLASSIAN_*` vars | local work-item store |
| WebRTC + Claude | Guardian | `ANTHROPIC_API_KEY` | deterministic scam rules |
| Elasticsearch | Guardian | `ELASTIC_URL` + `ELASTIC_API_KEY` | in-memory index |
| Armadin | red team | `ARMADIN_API_KEY` | local red-team suites (`unavailable`) |
| Apify (product search) | Care | `APIFY_TOKEN` | local store catalog |
| Apify (grocery Actor) | Care | `APIFY_TOKEN` + `APIFY_GROCERY_ACTOR_ID` | Actor code in-process on Open Prices |
| Bright Data | Care | `BRIGHTDATA_API_TOKEN` + `BRIGHTDATA_SERP_ZONE` | labeled sample listings |
| Visa checkout | Care | always sandbox | sandbox checkout, test card reference |
| Gemini | Care | `GEMINI_API_KEY` | fixed sample detection |
| Coinbase x402 | Care (Finance optional) | `X402_WALLET_PRIVATE_KEY` + `X402_PAY_TO` | local verifier, nothing settles |
| Bitdeer | Wellness | `BITDEER_API_KEY` | offline extractor |
| Moss | Wellness | `MOSS_PROJECT_ID` + key + `MOSS_INDEX_NAME` | in-process index |
| Backboard | Wellness | `BACKBOARD_API_KEY` | in-process index |
| Tiger Data | Wellness | `TIGERDATA_SERVICE_URL` | in-process time series |
| Snowflake | Wellness, family report | `SNOWFLAKE_ACCOUNT` + `SNOWFLAKE_TOKEN` | computed locally |
| Capital One Nessie | Finance | `NESSIE_API_KEY` | local Nessie emulator |
| CRS Credit API | Finance | `CRS_USERNAME` + `CRS_PASSWORD` | recorded P13 fixture |
| Billing office (Hyphenate) | Finance | always sandbox | simulated billing office |
| Factory Droid | Finance | `FACTORY_API_KEY` | local calculation engine (`unavailable`) |

## Safety design

- **Agents propose, people approve.** Sensitive tools cannot execute without an approval
  bound to the exact payload. Approvals expire and are single use; a changed cart,
  letter or quote needs a new one.
- **Security lives in code, not prompts.** Every model (Claude, Gemini, Bitdeer) is
  advisory. Policies such as `scamPolicy`, `pantryPolicy`, `observationPolicy`,
  `x402Policy` and the work-item gate make the decisions, and a model miss can never
  lower a risk level.
- **Untrusted input stays untrusted.** Call transcripts, messages, scraped listings,
  Actor output and uploaded documents are validated and sanitized before any agent or
  model sees them, and text that looks like injected instructions is dropped.
- **Isolation and consent.** Each agent's memory is namespaced and cannot be addressed
  by another agent. Cross-agent events need an explicit rule, the person's consent for
  that workflow, and a narrow payload schema, so whole conversations never cross.
  Blocked events are still recorded on `/activity`.
- **Red-team suites.** `src/redteam/` holds adversarial cases for Guardian's scam
  workflow and for the Wellness data path (consent bypass, cross-user access, deleted
  memory reappearing, duplicate analytics, and more). They run against the real deterministic layers via
  `npm run redteam` and `npm run redteam:wellness`, and in `npm test`.
- **No real money moves.** Checkout is a sandbox with a test card reference, Nessie
  holds fake money, x402 is testnet-only (mainnet refused in code), CRS is sandbox-only,
  and the billing office is simulated. Finance has no tool that moves money or
  creates purchases.
- **Tamper-evident audit.** Work-item histories and Finance case trails are SHA-256
  hash chains; the execution gate refuses to act on a broken chain, and a case's
  evidence packet can be re-verified by a third party.

## Getting started

Requirements: Node 20 or newer. Python 3 only if you want to run the Fetch.ai uAgents.

```bash
npm install
cp .env.example .env.local   # optional: every key is optional
npm run dev                  # http://localhost:3000
```

Open the Profile page (or `/api/status`) to see which integrations are live.

Useful commands:

```bash
npm test             # vitest suite (isolation, permissions, workflows, integrations, red team)
npm run typecheck    # tsc --noEmit
npm run lint
npm run build
npm run convex:dev   # deploy the Convex schema + functions, then set NEXT_PUBLIC_CONVEX_URL
```

Fetch.ai uAgents (optional):

```bash
pip install -r services/uagents/requirements.txt
npm run uagents      # starts the four uAgents (cd services/uagents && python bridge.py)
```

See [`services/uagents/README.md`](services/uagents/README.md) for ports and env vars.

### Terminal demos

Each demo runs the real workflow in Node and uses live services when their keys are in
`.env.local`, sandbox otherwise.

| Command | What it shows |
|---|---|
| `npm run demo:agents` | Wellness asks Guardian for help with consent (in-process bus, or uAgents with `FETCHAI_BRIDGE_URL`) |
| `npm run demo:scam` | Guardian screening a scam message |
| `npm run demo:scam-call` | Cartesia TTS -> Cartesia STT -> call screening -> Guardian warning |
| `npm run demo:search` | "has someone tried this scam before?" over Elasticsearch |
| `npm run demo:approval` | work items, dual control, hash-chained audit, Jira sync |
| `npm run demo:a2a` | Wellness -> Guardian over Fetch.ai uAgents (two processes) |
| `npm run serve:guardian` | host the Guardian intake for the uAgents |
| `npm run redteam` | Guardian adversarial suite |
| `npm run demo:shopping` | voice shopping: cart, approval, sandbox checkout, tracking |
| `npm run demo:groceries` | grocery discovery through the Apify Actor |
| `npm run demo:prices` | Bright Data price verification (e.g. `npm run demo:prices -- eggs`) |
| `npm run demo:pantry` | Gemini pantry photo to dinner (`-- fridge.jpg` for a real photo) |
| `npm run demo:x402` | Care paying for product data over x402 |
| `npm run demo:x402-finance` | Finance buying a report over x402 (sandbox, approval required) |
| `npm run demo:bitdeer` | Bitdeer observation extraction |
| `npm run demo:wellness-memory` | Wellness personal memory |
| `npm run demo:moss-continuity` | Moss continuity cues |
| `npm run moss:verify` | check Moss credentials and index |
| `npm run demo:backboard` | Backboard long-term context with Convex re-verification |
| `npm run demo:tigerdata` | Tiger Data weekly and monthly trends |
| `npm run demo:snowflake` | Snowflake household analytics |
| `npm run demo:household` | monthly family care report |
| `npm run demo:wellness-full` | the full Wellness pipeline |
| `npm run redteam:wellness` | Wellness adversarial suite |
| `npm run demo:nessie` | Finance spending review on Nessie |
| `npm run demo:credit` | Finance credit and identity review over CRS |
| `npm run demo:finance-case` | bill vs. EOB case through approval and billing office |
| `npm run demo:investigation` | bill investigation via Factory Droid |

## Deployment

Two Vercel projects deploy from this one repository:

| Project | Root directory | URL |
|---|---|---|
| `sahaya` (the app) | `.` | https://sahaya-mu.vercel.app |
| `sahaya-landing` (marketing site) | `landing/` | https://sahaya-landing-pink.vercel.app |

Both build from `main`. The deployed app runs in sandbox mode for any service whose env
vars are not set in the Vercel project settings; secrets stay in `.env.local` locally and
in the Vercel dashboard in production. The root `.vercelignore` excludes local env files,
`services/`, tests and demo scripts, and applies to both projects, so do not add
`landing/` to it. WebRTC call rooms are held in process memory, so for reliable two-person
calls run the call demo on a single server instance.
