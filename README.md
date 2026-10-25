# Kinline

**Four independent AI agents in one installable care companion.**

Kinline is a mobile-first PWA for older adults and their families. It is **not** one
chatbot with four prompts — it runs four separately instantiated agents, each with its
own persona, tool registry, scoped memory, approval policy, workflows and event
handlers. They share infrastructure but never each other's private data; they
collaborate only through a controlled, permission-checked event bus.

| Agent | Does | Never does |
|---|---|---|
| **Guardian** 🛡️ | Scam analysis, verification, emergencies, trusted-contact alerts, human assistance | meds, money, check-ins |
| **Care** ❤️ | Medications, grocery lists, carts, orders, meals, pantry | safety, money analysis, emotions |
| **Wellness** ✨ | Daily check-ins, mood/sleep/social observations, longitudinal trends, family calls | medical advice, bills, safety response |
| **Finance** 🧾 | Bill breakdowns, insurance/invoice audits, recurring charges, disputes, projections | meds, groceries, safety |

## Quick start

```bash
npm install
cp .env.example .env.local   # optional — everything runs without any keys
npm run dev                  # http://localhost:3000
npm test                     # isolation + cross-agent permission tests
```

**No API keys required.** With keys absent, Kinline runs in **sandbox mode**: a
deterministic per-agent planner drives the *same* real tools, approvals, memory and
event bus — so every workflow is demonstrable offline. Add keys to go live.

## Architecture

```
src/agents/
  base/
    BaseAgent.ts        reusable runtime: processMessage / processVoiceInput /
                        retrieveMemory / planTask / executeTool / requestApproval /
                        handleEvent / scheduleTask / getTaskStatus / initialize
    AgentEventBus.ts    controlled cross-agent collaboration (Convex-backed)
    ScopedMemory.ts     per-agent memory namespace isolation + shared-memory permissions
    ToolRegistry        each agent's tools (zod-validated, approval-gated, error-handled)
    policy.ts           ALL authorization in one place: memory perms + cross-agent rules
    services.ts         TaskService / ApprovalService
    dataLayer.ts        Convex when configured, else in-process (same interface)
  guardian/ care/ wellness/ finance/   <AgentId>Agent.ts + <id>Prompt.ts + <id>Tools.ts
  registry.ts  service.ts  consent.ts
convex/                  schema + functions (memories, events, tasks, approvals, conversations)
src/app/                 PWA: home, /agents, /agents/[agent], /activity, /family, /profile + /api/*
```

### Isolation (prompt §4)
`ScopedMemory` is bound to one agent id and physically forces `namespace = agentId` on
every read and write. There is no API to address another agent's namespace. Shared
household/user memory is reachable only with the permission declared in
`AGENT_PERMISSIONS`. Even `get(id)` refuses to return a record from another namespace.

### Cross-agent collaboration (prompt §5)
The only channel between agents is `AgentEventBus.publish()`, which enforces, in order:
1. an explicit rule exists in `CROSS_AGENT_RULES` for `(source, target, type)`;
2. the user has consented to that specific workflow;
3. the payload validates against the rule's **narrow** zod schema — so entire private
   conversations can never cross; unknown fields are stripped.

Disallowed events are still recorded (`blocked` / `rejected`) for the audit trail shown
on **Activity**, but never delivered. Wired workflows: Wellness→Guardian (safety),
Care→Guardian (assistance), Care→Finance (payment review), Wellness→Care (meal help).

### Approvals (prompt §9)
Tools flagged `requiresApproval` (emergency dispatch, notifying contacts, placing
orders, committing money) defer: the runtime creates an `Approval` and returns
`awaiting_approval` instead of executing. Approving it re-runs the tool with the gate
lifted. Shown as action cards in each agent's UI.

## Integrations — honestly labeled (prompt criterion 12)

Every integration reports `live` / `sandbox` / `unavailable` on **Profile** and
`/api/status`:

| Integration | Live when… | Fallback |
|---|---|---|
| **Claude** (`claude-opus-4-8`, adaptive thinking, tool use) | `ANTHROPIC_API_KEY` set | deterministic sandbox planner |
| **Convex** (primary backend / event store) | `NEXT_PUBLIC_CONVEX_URL` set | in-process store |
| **Cartesia** (voice TTS) | `CARTESIA_API_KEY` set | browser SpeechSynthesis |
| **Auth0** | `AUTH0_DOMAIN`+`AUTH0_CLIENT_ID` set | single demo user |
| **Moss** (personal memory) | `MOSS_API_KEY` set | Convex/in-process memory |
| **Apify** (grocery product search) | `APIFY_TOKEN` set | sandbox store catalog (per item, labeled) |
| **Checkout + tracking** | never (no commerce credentials) | sandbox checkout, Visa test-card reference, demo-paced tracking |

### Accessible voice shopping (Visa "Reimagining shopping")

Open **`/shop`** on a phone (or tap "Order my groceries" on Home, or "🛒 Groceries" in
Care). Flow: Margaret says "I need my usual groceries" → Care reads her order history
and preferences (usual items = bought in at least half of past orders) → product
search (Apify `apify~e-commerce-scraping-tool` when live) → the **deterministic
substitution policy** (`src/agents/care/shopping/substitution.ts`) picks her usual
brand, a reasonable swap within 30% of her usual price that respects dietary rules
(e.g. low-sodium) and dislikes (e.g. skim), or leaves the item off and says why →
an accessible cart (large type, plain-language reasons, one clear total, read-aloud)
→ she taps **Approve and pay $X** → sandbox checkout → live tracking timeline.

Code-enforced safety: approval is bound to the cart's id, hash and total; checkout
refuses a changed, superseded, already-ordered or over-limit cart; a spoken "yes"
never approves. The demo **ends at a sandbox checkout**: no card number is stored and
no money moves. Terminal walkthrough: `npm run demo:shopping`. Tests:
`tests/shopping.test.ts`. Optional env: `APIFY_TOKEN`, `APIFY_ACTOR_ID`,
`APIFY_MARKETPLACES`, `APIFY_TIMEOUT_MS`, `SHOP_TRACKING_STEP_MS`.
| **Bright Data** (Care price verification) | `BRIGHTDATA_API_TOKEN`+`BRIGHTDATA_SERP_ZONE` set | labeled sample listings |

### Shopping prices: discovery vs. verification

Care's shopping flow splits two jobs so the two web-data providers never run the
same search:

1. **Discovery** finds the structured product Care would normally buy (today the
   store catalog in `careTools.ts`; this is where Apify plugs in).
2. **Verification** (Bright Data, `src/integrations/brightdata.ts`) takes that
   product's name and asks the open market, Google Shopping via the SERP API, what
   it costs right now across retailers. Only the product name leaves Kinline.
3. Kinline validates every listing in code (`src/agents/care/priceCompare.ts`):
   schema check, USD-only prices, http(s) links, markup stripped, and listings
   carrying injected instructions dropped. Sizes are normalized (gal, half gal,
   fl oz, lb, oz, ct, dozen) to a per-unit price, and listings far below the
   median are flagged as suspicious.
4. Care reports whether the usual price is verified, above, or below the market,
   shows each listing's source and freshness (results older than 24h are stale
   and can't be added), and recommends the best in-stock unit price.
5. `addToDraftCart` adds the choice to a **draft** cart. Buying still goes
   through `requestOrderApproval`.

Demo: `npm run demo:prices` (or `npm run demo:prices -- eggs`), or ask Care
"Is my usual milk a good price right now?".
| **Gemini** (Care pantry-photo vision) | `GEMINI_API_KEY` set | fixed sample fridge detection (labeled sandbox) |

### Gemini: nutrition and meal assistance (Care)

Gemini has one distinct multimodal job: look at a fridge/pantry photo and propose
ingredients. Claude still does the conversation; a deterministic planner does the meal
planning. Open **Care → 🥕 Pantry** (`/care/pantry`):

1. Margaret photographs her refrigerator or pantry (downscaled in the browser, never stored).
2. Care sends it to Gemini (`GEMINI_MODEL`, default `gemini-3.8-flash`, via `generateContent`).
3. `pantryPolicy.ts` validates the result in code: clear items are pre-confirmed, items
   under 75% confidence are held back, and text read off notes/labels is rejected.
4. Care asks Margaret to confirm the uncertain items (planning is refused until she does).
5. `mealPlanner.ts` combines confirmed ingredients with her preferences (allergies and
   vegetarian are hard filters; low sodium, soft foods, dislikes, prep time).
6. Care proposes a recipe and drafts a grocery list of missing items. Ordering still goes
   through the normal approval gate.

Demo: `npm run demo:pantry` (sandbox), or `npm run demo:pantry -- fridge.jpg` with
`GEMINI_API_KEY` set for a real vision call. Tests: `tests/pantryNutrition.test.ts`.
| **Coinbase x402** (Care pays for product data, Base Sepolia test USDC only) | `X402_WALLET_PRIVATE_KEY`+`X402_PAY_TO` set | throwaway key + local signature verifier, nothing settles (`npm run demo:x402`) |

To run the Convex backend: `npx convex dev` (generates `convex/_generated`, deploys the
schema + functions), set `NEXT_PUBLIC_CONVEX_URL`, restart. The app auto-switches.

## Acceptance criteria

1. ✅ Four agent pages on mobile (`/agents/guardian|care|wellness|finance`).
2. ✅ Each has a distinct functional conversation (own prompt + tools + planner).
3. ✅ Own tools and persistent history (per-agent memory namespace + conversation store).
4. ✅ Meaningful end-to-end workflow per agent (e.g. Care: prefs→cart→approval→order→Finance review).
5. ✅ Tasks persist with real status and steps.
6. ✅ Caregivers see authorized updates (Family dashboard, consent-gated).
7. ✅ Cross-agent events with explicit permission checks (Activity audit trail).
8. ✅ Voice and text both function (mic + typing; Cartesia or browser TTS).
9. ✅ Sensitive actions require approval.
10. ✅ Installable, responsive PWA (manifest + service worker + icons).
11. ✅ Automated tests verify isolation and cross-agent permissions (`npm test`, 15 tests).
12. ✅ Integrations identified as live/sandbox/unavailable.

## Tests

`tests/isolation.test.ts` — memory namespace isolation, shared-memory permissions,
distinct tool registries. `tests/crossAgent.test.ts` — the event bus allow/block/reject
rules, consent gating, payload narrowing (no whole-conversation transfer), inbox
targeting. `tests/workflows.test.ts` — approval gating + the full Care→Finance and
Wellness→Guardian flows.

## Notes / honest limitations
- Sandbox mode uses keyword planners, not an LLM; add `ANTHROPIC_API_KEY` for real
  reasoning. The tool execution, memory, approvals and event bus are identical in both modes.
- Scheduled jobs (`scheduleTask`) persist intent; wiring them to Convex cron is the
  natural next step for live deployments.
- Auth0 is declared and gated but not fully wired to a login flow (demo user by default).
