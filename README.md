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
