# Sahaya

**Four independent AI agents in one installable care companion.**

Sahaya is a voice-first, mobile-first PWA for older adults and the families who look
after them. It is not one chatbot with four prompts: Guardian, Care, Wellness and
Finance are separately instantiated agents, each with its own prompt, tools, scoped
memory and approval policy. They cooperate only through a permission-checked event
bus, and anything sensitive (alerting family, placing an order, sending a dispute
letter, reading a bank account) waits for a person to approve it. That rule is
enforced in code, not in a prompt.

- Live app: https://sahaya-mu.vercel.app
- Landing page: https://sahaya-landing-pink.vercel.app

| Agent | Does | Never does |
|---|---|---|
| **Guardian** | Scam screening for messages and calls, caller verification, trusted-contact alerts, help coordination | meds, money, check-ins |
| **Care** | Groceries, carts, price checks, pantry-to-dinner, sandbox checkout | safety, money analysis, emotions |
| **Wellness** | Daily check-ins, mood/sleep/social observations, continuity, trends, family report | medical advice, bills, safety response |
| **Finance** | Spending review, credit and identity review, bill vs. insurance investigation, dispute drafts | moving money, meds, groceries |

## Quick start

```bash
npm install
cp .env.example .env.local   # optional: every key is optional
npm run dev                  # http://localhost:3000
npm test                     # isolation, permissions, workflows, red team
```

No API keys are required. Without a key, each service runs in **sandbox mode**: the
same tools, approvals, memory and event bus run against a local stand-in, and every
integration is labeled `live`, `sandbox` or `unavailable` on the Profile page and at
`/api/status`.

## Services we use

### Platform (all agents)

#### Claude (Anthropic) - Reasoning for every agent

Used as the brain of Guardian, Care, Wellness and Finance: conversation, planning and tool use.

Anthropic provides the Claude models (default `claude-opus-4-8` with adaptive thinking) and the tool-use API the agents run on.

**End-to-end workflow:**
1. The person speaks or types to one agent.
2. That agent's runtime sends the message, its own prompt and only its own tools to Claude.
3. Claude plans and calls tools; each call is validated before it runs.
4. Tools marked sensitive stop at an approval card instead of executing.
5. Claude also does narrow advisory jobs (screening call transcripts, summarizing past scams, categorizing purchases, explaining credit findings, comparing bills), and code checks every output before it is used.
6. The agent replies with the result.

**Demo:** Ask Care "I need my usual groceries" or Guardian "Someone says my grandson is in jail" and watch the tool calls and approval cards appear.

**Implementation:** `src/lib/llm.ts` and `src/agents/base/BaseAgent.ts`. Without `ANTHROPIC_API_KEY`, a deterministic per-agent planner drives the same tools.

#### Convex - Canonical data store and event bus

Used as the source of truth for agent memory, cross-agent events, tasks, approvals and conversations.

Convex provides a realtime backend database with server functions.

**End-to-end workflow:**
1. Every agent reads and writes only its own memory namespace in Convex.
2. When one agent needs another (for example Care asking Finance for a payment review), it publishes an event.
3. The event bus checks there is a rule for that pair, that the person consented, and that the payload fits a narrow schema.
4. Allowed events are delivered; blocked ones are still stored for the audit trail.
5. Moss, Backboard, Tiger Data and Snowflake copies are always checked back against Convex.

**Demo:** Run a Wellness check-in that raises a safety concern, then open `/activity` to see the Wellness -> Guardian event and any blocked attempts.

**Implementation:** `convex/` (schema and functions) and `src/agents/base/dataLayer.ts`. Without `NEXT_PUBLIC_CONVEX_URL`, an in-process store with the same interface is used.

#### Cartesia - Voice in and voice out

Used to give each agent a spoken voice and to transcribe live call audio for scam screening.

Cartesia provides `sonic-3` text-to-speech and `ink-whisper` streaming speech-to-text.

**End-to-end workflow:**
1. An agent's reply is spoken with that agent's own Cartesia voice.
2. During a screened call, the protected person's browser streams the caller's audio to Cartesia STT.
3. The browser only receives a short-lived, STT-only token from `/api/voice/stt-token`; the API key stays on the server.
4. The live transcript goes to call screening (see WebRTC below).
5. Guardian warns the person privately in its own Cartesia voice.

**Demo:** Open `/call` and press **Play demo scam call**, or run `npm run demo:scam-call` for the headless version (TTS -> STT -> screening -> Guardian warning).

**Implementation:** `src/integrations/cartesia.ts`, `src/lib/cartesiaStt.ts`, `src/app/api/voice/`. Without `CARTESIA_API_KEY`, the browser's built-in speech APIs are used.

#### Auth0 - Who the agents are acting for

Used to identify the signed-in older adult or caregiver so agents act for the right person.

Auth0 provides hosted login and session management.

**End-to-end workflow:**
1. The person signs in through Auth0.
2. The app resolves the session to a Sahaya user.
3. Every agent call, memory read and approval is scoped to that user.
4. Wellness and Finance report whether they are acting for a verified session or the demo user.

**Demo:** Open the Profile page to see the Auth0 status and the current user.

**Implementation:** `src/lib/user.ts` and `auth0Status()` in `src/lib/env.ts`. The full login flow (`@auth0/nextjs-auth0` v4, `/auth/login`, `/auth/callback`) is in draft PR #13; until it merges, the app runs as a single demo user.

#### Fetch.ai - Communication between independent agents

Used to connect Guardian, Care, Wellness, and Finance through real agent-to-agent messaging.

Fetch.ai provides the uAgents framework and Agentverse infrastructure for independent agents to communicate.

**End-to-end workflow:**
1. Wellness receives: "I don't have anyone to help me get groceries."
2. Wellness obtains permission to request help.
3. It sends a structured assistance request to Guardian through a Fetch.ai-compatible agent.
4. Guardian accepts the request and begins the helper-coordination workflow.
5. Guardian sends back a task identifier and status.
6. Wellness reports the result to the user.

**Demo:** Two independent agents exchange a real message while their execution logs update (`npm run demo:a2a`, or the live log panel on `/activity`).

**Implementation:** The existing TypeScript agents stay authoritative. A small Python uAgents service (`services/uagents/`) runs each agent as its own process; the Guardian uAgent verifies the sender and forwards to the app's Guardian intake. See `src/integrations/fetchai.ts`.

#### Atlassian Jira - Human review for sensitive agent actions

Used to put sensitive and cross-agent actions in front of a human reviewer before anything executes.

Atlassian provides Jira Cloud issues, workflows and the REST API for two-way status sync.

**End-to-end workflow:**
1. Guardian wants Finance to act on something (for example reviewing a suspicious charge).
2. Sahaya creates a work item with a hash-chained history; the reviewer role and approval count come from policy, not from the agent.
3. The work item is mirrored to a Jira issue.
4. A bound reviewer approves (high-risk items need two).
5. The status syncs back, but a Jira status alone never authorizes execution: code checks the hash chain, reviewer roles, input hash, expiry and single use.
6. Only then does Finance run the action, and every step is audited.

**Demo:** `npm run demo:approval`, then open `/approvals`. With Jira credentials set this creates a real Jira issue.

**Implementation:** `src/integrations/jira.ts`, `src/agents/base/workItems.ts`, `src/agents/base/workItemPolicy.ts`. Without `ATLASSIAN_*` vars, a local work-item store with the same gate is used.

#### Vercel - Hosting

Used to host the app and the landing page.

Vercel provides Git-connected builds and serverless hosting for Next.js.

**End-to-end workflow:**
1. A change is merged to `main`.
2. Vercel builds two projects from this one repo: the app (root `.`) and the landing page (root `landing/`).
3. The new production build goes live at the URLs above.
4. Any service without env vars set in Vercel runs in sandbox mode on the deployed app.

**Demo:** Open https://sahaya-mu.vercel.app and check `/api/status`.

**Implementation:** `.vercelignore` keeps local env files, `services/`, tests and demo scripts out of the upload.

### Guardian (scam protection)

#### WebRTC + Claude - Live scam-call screening

Used to screen a live call for scam tactics while it is happening and warn the person privately.

WebRTC provides peer-to-peer audio between two browsers; Claude assesses the rolling transcript.

**End-to-end workflow:**
1. The protected person opens `/call` and shares a room code; the caller joins.
2. Audio flows peer to peer; the server only relays the connection offer and answer.
3. The caller's audio is transcribed (Cartesia STT) and the rolling transcript is screened.
4. Claude and the deterministic scam-signal rules both score it; Claude can raise the risk but never lower it.
5. At high risk, Guardian's workflow runs once per call: the policy decides, the incident is saved and caregivers are alerted.
6. Guardian warns the person privately.

**Demo:** On `/call`, press **Play demo scam call**: a fictional "grandson" asks for gift cards and Guardian usually flags it by the second line.

**Implementation:** `src/integrations/webrtc.ts`, `src/integrations/callScreening.ts`, `src/app/api/voice/call/`. Without `ANTHROPIC_API_KEY`, only the deterministic rules screen calls.

#### Elastic - "Has someone tried this scam before?"

Used to search the person's own past scam incidents so Guardian can say whether a new scam matches an old one.

Elastic provides Elasticsearch full-text and filtered search.

**End-to-end workflow:**
1. Guardian saves a scam incident to Convex.
2. An indexing job writes a PII-redacted, allowlisted copy to Elasticsearch (only with consent).
3. The person asks "Has someone tried this scam before?"
4. Elasticsearch searches only that person's incidents by text and scam tactics.
5. Claude drafts a plain-language answer; code rejects drafts that cite unknown incidents, skip the top match, or claim it was the "same caller".
6. Guardian answers with the matches and a caveat.

**Demo:** `npm run demo:search` (uses a throwaway user and cleans up after itself).

**Implementation:** `src/integrations/search.ts`, `src/agents/guardian/incidentIndexer.ts`, `src/agents/guardian/incidentSummary.ts`. Without `ELASTIC_URL`, a local in-memory index is used.

### Care (groceries, meals, shopping)

#### Visa - Accessible voice shopping

Used to turn "I need my usual groceries" into an approved, tracked order without a small-print checkout screen.

Visa's "Reimagining shopping" track inspired the flow; Sahaya ends at a sandbox checkout with a Visa test-card reference.

**End-to-end workflow:**
1. Margaret says "I need my usual groceries."
2. Care reads her order history and preferences to find her usual items.
3. Care searches for products (Apify) and a deterministic substitution policy picks her usual brand, a fair swap that respects her diet, or leaves the item off and says why.
4. She sees a large-type cart with plain-language reasons and one clear total.
5. She taps **Approve and pay**; approval is bound to the cart's id, hash and total, and a spoken "yes" never approves.
6. Sandbox checkout places the order and a tracking timeline follows it to delivery.

**Demo:** Open `/shop` on a phone, or run `npm run demo:shopping`.

**Implementation:** `src/agents/care/shopping/` and `src/integrations/checkout.ts` (always sandbox: no card number stored, no money moves).

#### Apify - Grocery product discovery

Used to find real products and prices for a shopping list.

Apify provides Actors (cloud scrapers and data jobs) and an API to run them and read their datasets.

**End-to-end workflow:**
1. The person gives Care a list: "Buy coffee and apples."
2. Care runs Sahaya's own Grocery Product Discovery Actor on Apify.
3. The Actor pulls offers from permitted open data (Open Food Facts and Open Prices) and returns normalized names, prices, availability and source links.
4. Sahaya treats the output as untrusted: schema-validated, sanitized, URL-restricted and price-bounded.
5. Care compares the offers and builds a draft cart; the Apify run id is shown as proof of a real run.
6. Ordering still needs approval.

**Demo:** `npm run demo:groceries -- "coffee, apples"` or the `/groceries` page.

**Implementation:** `actors/grocery-product-discovery/` (the Actor), `src/integrations/apifyGrocery.ts`, and `src/integrations/apify.ts` for `/shop` product search. Without `APIFY_TOKEN`, the Actor's code runs in-process and is labeled sandbox.

#### Bright Data - Independent price verification

Used to check whether the product Care would normally buy is a fair price right now.

Bright Data provides the SERP API for structured search results such as Google Shopping.

**End-to-end workflow:**
1. Care already knows the usual product (from discovery).
2. Only the product name is sent to Google Shopping through Bright Data.
3. Code validates every listing: USD only, safe links, injected instructions dropped.
4. Sizes are normalized to a unit price, suspiciously cheap listings are flagged, and results older than 24 hours are marked stale.
5. Care reports whether the usual price is fair, above or below market, and recommends the best in-stock unit price.
6. A chosen listing goes into a draft cart; buying still needs approval.

**Demo:** Ask Care "Is my usual milk a good price right now?" or run `npm run demo:prices -- eggs`.

**Implementation:** `src/integrations/brightdata.ts`, `src/agents/care/priceCompare.ts`. Without `BRIGHTDATA_API_TOKEN`, clearly labeled sample listings are used.

#### Google Gemini - Pantry photo to dinner

Used to look at a fridge or pantry photo and suggest what is in it.

Google provides the Gemini multimodal models.

**End-to-end workflow:**
1. Margaret photographs her fridge (downscaled in the browser, never stored).
2. Gemini proposes the visible ingredients; that is its only job.
3. Code holds back anything under 75% confidence and rejects text read off notes or labels.
4. Care asks her to confirm the uncertain items; planning is refused until she does.
5. A deterministic meal planner proposes a recipe that respects allergies and preferences.
6. Missing items become a draft grocery list that still goes through approval.

**Demo:** Open **Care -> Pantry** (`/care/pantry`), or run `npm run demo:pantry -- fridge.jpg`.

**Implementation:** `src/integrations/gemini.ts`, `src/agents/care/pantryPolicy.ts`, `src/agents/care/mealPlanner.ts`. Without `GEMINI_API_KEY`, a fixed sample detection is used.

#### Coinbase x402 - Agents paying for data, with limits

Used to let Care buy small pieces of product-comparison data from a paid service, under strict spending limits.

Coinbase provides the x402 protocol (HTTP 402 Payment Required) with USDC payments.

**End-to-end workflow:**
1. Care asks the paid service for a product comparison.
2. The service answers 402 with a price.
3. Sahaya's payment policy checks the request: test network only, known payee, registered service, within $0.05 per lookup and $0.25 per day.
4. Care signs a USDC authorization on Base Sepolia (testnet); anything outside the mandate needs an approval.
5. The service verifies the payment and returns the data.
6. Finance receives a receipt event for its records.

**Demo:** `npm run demo:x402`. An optional experiment, `npm run demo:x402-finance`, lets Finance buy reports only with an approval for every purchase.

**Implementation:** `src/integrations/x402.ts`, `src/agents/care/paidServices/`, `src/app/api/x402/`. Without a test wallet, a throwaway key and a local verifier are used and nothing settles.

### Wellness (check-ins, memory, trends)

#### Bitdeer AI - Structured wellness observations

Used to turn a casual check-in into structured observations about mood, sleep and social contact.

Bitdeer AI provides OpenAI-compatible model inference (default `deepseek-ai/DeepSeek-V4-Flash`).

**End-to-end workflow:**
1. Margaret says "I only slept about four hours and haven't seen anyone this week."
2. Personal details are stripped before anything leaves Sahaya.
3. Bitdeer extracts candidate observations.
4. A deterministic policy accepts only observations that fit the schema, are grounded in her words, and contain no medical claims.
5. Accepted observations are saved to Convex with provenance.
6. Wellness responds with a gentle, non-diagnostic follow-up.

**Demo:** `npm run demo:bitdeer -- "I only slept four hours"`, or the Model inference panel on `/wellness`.

**Implementation:** `src/integrations/bitdeer.ts`, `src/agents/wellness/extractObservations.ts`. Without `BITDEER_API_KEY`, an offline extractor runs under the same validation.

#### Moss - Conversation continuity

Used to help Wellness pick up where the last conversation left off.

Moss provides fast semantic retrieval over indexed documents.

**End-to-end workflow:**
1. A conversation ends and Wellness has accepted observations.
2. Only short, templated, consented cues go to Moss ("Sleep came up: hasn't been sleeping well."), under opaque ids and a pseudonymous subject.
3. Health details, medications and identifiers stay in Convex only.
4. Next time, Wellness asks Moss only for documents Convex says belong to her.
5. Each result is checked against Convex and tampered ones are dropped.
6. Wellness opens with "Are you sleeping any better?"

**Demo:** `npm run demo:moss-continuity`, and `npm run moss:verify` to probe live credentials.

**Implementation:** `src/integrations/moss.ts`, `src/agents/wellness/continuityMemory.ts`. Without Moss credentials, an in-process index with the same behavior is used.

#### Backboard - Long-term life context

Used to remember the things the person chose to share (hobbies, family visits, plans) across days and weeks.

Backboard provides persistent memory for AI assistants.

**End-to-end workflow:**
1. Margaret mentions her granddaughter is visiting on Saturday.
2. With consent, Wellness saves the fact in Convex and indexes a minimized copy in her own Backboard assistant.
3. Days later, Wellness searches Backboard for relevant context.
4. Every hit is re-verified against Convex: active, unchanged, within retention, and consent still on.
5. Wellness uses the Convex text, never Backboard's copy.
6. Wellness asks "How was your granddaughter's visit?"

**Demo:** `npm run demo:backboard` (day 0 -> day 9, correct, forget and revoke).

**Implementation:** `src/integrations/backboard.ts`, `src/agents/wellness/conversationContext.ts`. Without `BACKBOARD_API_KEY`, an in-process index with the same re-verification is used.

#### Tiger Data - Longitudinal wellness trends

Used to spot real changes in sleep and energy against the person's own baseline.

Tiger Data provides managed TimescaleDB (Postgres with time-series hypertables).

**End-to-end workflow:**
1. Wellness saves numeric observations (sleep hours, energy) in Convex.
2. A sync job mirrors them into a Tiger Data hypertable, keyed by observation id so corrections and deletions propagate.
3. Weekly and monthly trends are computed in the database with `time_bucket`.
4. A change is reported only when it is meaningful and outside the normal range.
5. Trends show on `/wellness`, and on `/family` without quotes unless the person allowed it.
6. Turning consent off purges the mirror.

**Demo:** On `/wellness`, click **Load 4-week demo history**, then type "I only slept about four hours last night". Or run `npm run demo:tigerdata`.

**Implementation:** `src/integrations/tigerdata.ts`, `src/agents/wellness/timeSeriesSync.ts`, `src/agents/wellness/longitudinalTrends.ts`. Without `TIGERDATA_SERVICE_URL`, an in-process time series is used.

#### Snowflake - Monthly family care report

Used to give the family a monthly summary without sharing private details.

Snowflake provides a cloud data warehouse with a SQL REST API.

**End-to-end workflow:**
1. Care confirmations and Guardian help requests happen during the month.
2. With consent, each is reduced to a de-identified fact (category, outcome, day) that must pass a strict schema.
3. Facts load into one Snowflake table, idempotently.
4. Snowflake computes the monthly summary with a single `GROUP BY`.
5. Sahaya reads back only the aggregates for authorized households.
6. The family sees the report on `/family`; revoking consent withdraws that category.

**Demo:** `npm run demo:household`, or the Monthly care report card on `/family`.

**Implementation:** `src/integrations/snowflake.ts`, `src/analytics/householdCareExport.ts`, `src/analytics/familyCareReport.ts`. Without Snowflake credentials, the summary is computed locally.

### Finance (spending, credit, bills)

#### Capital One Nessie - Spending review

Used to review a checking account for double charges, subscriptions and price increases.

Capital One provides Nessie, a sandbox banking API with test customers, accounts and purchases.

**End-to-end workflow:**
1. Margaret asks "What subscriptions am I paying for?"
2. Finance asks for read-only access to her checking account (approval card).
3. Finance reads purchases only from that authorized account; only the last four digits are stored.
4. Claude categorizes purchases (labels validated in code).
5. Code finds possible double charges, monthly subscriptions and price increases.
6. Finance suggests actions she can accept (draft a dispute or add a to-do) or dismiss; nothing is sent or cancelled.

**Demo:** On `/money`, use **Post a double charge**, then **Review my spending again** to see it flagged. Or run `npm run demo:nessie`.

**Implementation:** `src/integrations/nessie.ts`, `src/agents/finance/nessie/`. Finance has no tool that creates purchases. Without `NESSIE_API_KEY`, a local emulator with Nessie's shapes is used.

#### CRS Credit API - Credit and identity review

Used to check a credit report and identity signals and explain them in plain language.

CRS provides sandbox access to TransUnion credit reports, TransUnion identity verification and AtData FraudFinder.

**End-to-end workflow:**
1. Margaret asks Finance "Is my credit okay?"
2. Finance needs her approval and a credit-review consent, and only the linked test identity is allowed.
3. Finance requests the credit report, identity verification and fraud signals from the CRS sandbox.
4. Code turns the fields into evidence-backed findings and changes since the last review.
5. Claude explains the findings (validated in code); next steps come from a fixed table.
6. The SSN is never stored, and every step is audited.

**Demo:** `npm run demo:credit`.

**Implementation:** `src/integrations/crs.ts`, `src/agents/finance/credit/`. Production CRS hosts and non-test SSNs are refused. Without CRS credentials, a recorded sandbox fixture is used.

#### Hyphenate - Autonomous medical bill investigation

Used to find billing errors by comparing a hospital bill with the insurance explanation of benefits (EOB), then dispute them with approval.

The Hyphenate track (autonomous systems for finance) defined the challenge: real work, bounded autonomy, least privilege, human approval and a defensible audit.

**End-to-end workflow:**
1. Margaret uploads her hospital statement and EOB.
2. Finance extracts both with a deterministic parser that keeps each fact's source line and document hash.
3. Code reconciles them: in the sample, a lab test is billed twice and the EOB denied the duplicate, which explains the $148 gap.
4. Finance builds a case with evidence, math and a dispute letter to the billing contact on the bill's letterhead.
5. Margaret reviews, can remove a finding, and approves the exact letter.
6. Finance submits it to the sandbox billing office, tracks the response, and verifies the corrected balance.

**Demo:** Open `/finance/case` and tap **Use Margaret's sample documents**, or run `npm run demo:finance-case`.

**Implementation:** `src/agents/finance/investigation/` and `src/integrations/billingOffice.ts` (always sandbox; hospitals have no public dispute API). Every step is in a SHA-256 hash-chained audit trail that can be exported as an evidence packet.

#### Factory Droid - Bounded investigation worker

Used to hand a bill investigation to a separate execution agent that can only use the tools Sahaya gives it.

Factory provides the Droid SDK for running Droid agents from inside an app.

**End-to-end workflow:**
1. Margaret asks Finance to investigate a bill.
2. Finance starts a Droid run in an empty, throwaway working directory.
3. Every built-in Droid tool (shell, files, web) is disabled; only Sahaya's read-only calculation tools are allowed.
4. The authorized documents are attached; the Droid has no other data access.
5. The Droid reports its findings, and Finance checks them against its own recomputation.
6. Finance explains the result and drafts a dispute that needs approval.

**Demo:** Open `/finance/investigate`, or run `npm run demo:investigation`.

**Implementation:** `src/integrations/factoryDroid.ts`. Without `FACTORY_API_KEY`, the investigation runs on Finance's local calculation engine and is labeled as such.

## All demos

| Command | Shows |
|---|---|
| `npm run demo:agents` | Wellness asks Guardian for help with consent |
| `npm run demo:a2a` | Wellness -> Guardian over Fetch.ai uAgents (two processes) |
| `npm run demo:scam` | Guardian screening a scam message |
| `npm run demo:scam-call` | Cartesia TTS -> STT -> call screening -> Guardian warning |
| `npm run demo:search` | Elastic incident search |
| `npm run demo:approval` | Work items, dual control, hash-chained audit, Jira sync |
| `npm run demo:shopping` | Voice shopping to sandbox checkout and tracking |
| `npm run demo:groceries` | Apify grocery discovery |
| `npm run demo:prices` | Bright Data price verification |
| `npm run demo:pantry` | Gemini pantry photo to dinner |
| `npm run demo:x402` / `demo:x402-finance` | x402 paid data for Care / Finance |
| `npm run demo:bitdeer` | Bitdeer observation extraction |
| `npm run demo:moss-continuity` | Moss continuity cues |
| `npm run demo:backboard` | Backboard long-term context |
| `npm run demo:tigerdata` | Tiger Data trends |
| `npm run demo:snowflake` / `demo:household` | Snowflake analytics and family report |
| `npm run demo:wellness-full` | The full Wellness pipeline |
| `npm run demo:nessie` | Nessie spending review |
| `npm run demo:credit` | CRS credit and identity review |
| `npm run demo:finance-case` | Bill vs. EOB investigation |
| `npm run demo:investigation` | Factory Droid investigation |
| `npm run redteam` / `redteam:wellness` | Adversarial suites for Guardian and Wellness |

Demos use live services when keys are in `.env.local`, sandbox otherwise. Note that
`demo:approval` creates a real Jira issue when Atlassian credentials are present.
