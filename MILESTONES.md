# Kinline — Guardian Safety Platform Milestones

This file tracks the five-track build layered on the existing four-agent Kinline
runtime (BaseAgent, tool registry, AgentEventBus, approvals, scoped memory,
integration-status). Each track is implemented, tested, given a one-command demo,
type-checked/linted/tested, committed, and recorded in PROGRESS.md.

Shared demo scenario (fictional): Margaret receives
"Grandma it's Jake, I'm in trouble. Please send $2,000 in gift cards today and
don't tell mom." Jake is fake. Seed: Margaret; real grandson Jake with a trusted
phone; daughter as caregiver with `incidents:view`; 8-10 past scam incidents.

## Track 1 — Guardian scam workflow (core)

Flow: suspicious message -> advisory signal detection (Claude, or deterministic
regex in sandbox) flags signals + risk -> **deterministic policy engine** decides
-> independent verification via the trusted-contact directory only -> incident
saved -> caregiver notified if authorized.

Design:
- `scamSignals.ts` — advisory layer. Detects scam signals, risk level, and any
  contact/callback numbers embedded in the message. Advisory only: it can never
  trigger an action by itself.
- `scamPolicy.ts` — pure, deterministic policy engine (no I/O). Encodes the five
  rules below and is unit-tested directly:
  1. Never disclose personal/financial/contact info based on an inbound message.
  2. Any payment / gift card / wire / crypto action is blocked unless a valid
     approval exists.
  3. Contact details / callback numbers supplied inside the message are ignored.
  4. Verification contacts a person from the trusted-contact directory only,
     through the stored channel (simulated).
  5. Caregivers see an incident only if they hold the `incidents:view` permission.
- `scamWorkflow.ts` + `screenInboundMessage` Guardian tool — orchestration that
  ties detection -> policy -> verification -> incident -> caregiver alert using
  the existing memory / approval / event-bus abstractions plus a new reusable
  audit log (`base/audit.ts`).
- `scamScenario.ts` — seeds the Margaret scenario for the demo and tests.
- Incident record: id, user, channel, received_at, raw message, risk level,
  signals, policy decisions, verification {contact, method, status, result,
  timestamps}, outcome, visibility.

Demo: `npm run demo:scam`.
Acceptance: the Margaret scenario produces a warning, a blocked transfer, a
simulated verification to the real Jake, a stored incident, and a caregiver alert,
all visible via the audit log.

## Track 2 — Adversarial red-team harness (Armadin-inspired)
Automated suite of >=30 attack cases against Guardian. `npm run redteam` records
for each case the verdict, which layer stopped it (signal / policy / approval),
and pass/fail; writes a readable report; exits non-zero on any failure. At least
three cases must show a model/signal-level miss that the deterministic policy
layer still catches. Armadin shown as `unavailable` unless real API access.

## Track 3 — Controlled agent actions (Atlassian/Jira-style)
Work-item model + WorkItemStore with a sandbox local store (and a JiraAdapter
behind the same interface, honestly `unavailable` without creds). Execution gate
in code: a tool runs only with a valid approval (right agent, tool, input hash,
reviewer role, not expired, single-use). A Jira "Approved" status alone is never
enough. Demo: `npm run demo:approval`.

## Track 4 — Elastic incident search
Index permitted, PII-redacted incident text after each save; a Guardian search
tool with filters; sandbox in-memory search behind the same interface.
Demo: `npm run demo:search`.

## Track 5 — Fetch.ai agent-to-agent messaging
Python uAgents bridge (wellness + guardian) exchanging typed messages, TS agents
calling bridges over local HTTP, only declared bus events crossing. Sandbox
fallback to the in-process bus, honestly `unavailable` when Python/uagents absent.
Demo: `npm run demo:agents`.

---

# Part 5 — Wellness Agent (Bitdeer AI, integration & security)

Layered on the same four-agent runtime. Reuses the Claude orchestrator, Convex,
tool registry, event bus, consent, approvals, audit log, and integration-status
registry — no infrastructure duplicated. Built in three tracks.

## Part 5 Track A — Bitdeer AI Model Studio (structured extraction)
Verified against Bitdeer's official docs: OpenAI-compatible inference at
`https://api-inference.bitdeer.ai/v1/chat/completions`, `Authorization: Bearer`,
real models (e.g. `deepseek-ai/DeepSeek-V4-Flash`, GLM-5.2, Qwen3.5-397B-A17B).

- `WellnessInferenceProvider` interface with `BitdeerInferenceAdapter` (real API,
  plain fetch, no new SDK) and `SandboxWellnessInferenceAdapter` (deterministic
  offline, same interface). Claude stays the conversational orchestrator; the
  inference provider is strictly advisory.
- Workflow: consent check → privacy minimization → provider inference → strict
  schema validation → evidence grounding against the source → reject/confirm
  uncertain → store canonical with model provenance → surface on the dashboard.
- Deterministic policy engine (`observationPolicy.ts`): schema + injection +
  medical + evidence + unit/range. Never converts vague descriptions into invented
  numbers; never emits diagnoses or medication advice. All decisions in code.
- Demo: `npm run demo:bitdeer` (real request when configured, else labeled sandbox).

## Part 5 Track B — Full integration + unified dashboard
- Integration adapters, each live/sandbox behind one interface: Moss (continuity
  memory), Backboard (historical context), Tiger Data (sleep/energy time series +
  trends, idempotent on observation id), Snowflake (de-identified household
  analytics with authorization + consent withdrawal).
- Main scenario (`runWellnessTurn`): Claude understands → Bitdeer extracts → policy
  validates → Convex stores canonical → Moss continuity → Backboard history →
  Tiger Data trend → contextual non-diagnostic follow-up → authorized household
  aggregates → Sarah sees only permitted analytics. External failures never corrupt
  Convex and never block the core turn; failed syncs are reported honestly.
- Canonical store with provenance, dedup, in-place correction (keeps history), and
  soft-delete (hidden from all active readers, retained for audit).
- Unified Wellness Dashboard (`/wellness`): conversation entry, recent
  observations with review/correct/forget, personal & historical memory, sleep/
  energy trends, monthly household report, consent & privacy controls, integration
  status, audit timeline. Accessible, mobile-first, senior-readable.
- Demos: `npm run demo:wellness-memory`, `demo:backboard`, `demo:tigerdata`,
  `demo:snowflake`, `demo:wellness-full`.

## Part 5 Track C — Wellness security & red-team
32 adversarial cases (≥30 required) covering all the prompt's scenarios run against
the REAL deterministic enforcement (policy engine, scoped memory, consent gate,
canonical store, household authorization, integration-honesty reporting). Each case
records id, input, expected behavior, actual result, enforcement layer, pass/fail,
and an audit reference. `npm run redteam:wellness` writes a report and exits
non-zero on any failure or fewer than 30 cases. Enforcement fixes went into code
(e.g. the injection layer), not prompts.
