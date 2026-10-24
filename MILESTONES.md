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
