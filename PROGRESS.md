# Kinline — Guardian Safety Platform Progress

Status of the five-track build (see MILESTONES.md for the plans). Run commands
from the repo root.

## Verification commands
- `npm run typecheck` — passes.
- `npm test` — passes (29 tests).
- `npm run build` — passes (Next 15.5.28).
- `npm run demo:scam` — passes, prints the Margaret scenario end to end.
- `npm run lint` — NOT configured in this repo (no ESLint setup; `next lint` drops
  into interactive setup). Static checking is covered by `npm run typecheck`.

## Track 1 — Guardian scam workflow ✅ done
- `src/agents/guardian/scamSignals.ts` — advisory signal detection + requested-action
  classification + embedded-contact extraction. Advisory only.
- `src/agents/guardian/scamPolicy.ts` — PURE deterministic policy engine (the five
  rules), unit-tested directly. Security decisions live here, not in prompts.
- `src/agents/guardian/scamWorkflow.ts` — orchestration: detect → policy → verify
  (trusted directory only) → incident → caregiver alert. Exposed as the Guardian
  tool `screenInboundMessage` and reached by the sandbox planner.
- `src/agents/base/audit.ts` — reusable append-only audit log (shared namespace);
  wired into `ToolContext` + `BaseAgent` so every agent can audit.
- `src/agents/guardian/scamScenario.ts` — Margaret seed (Jake trusted contact,
  Sarah caregiver with `incidents:view`, 10 past incidents). Fictional data only.
- Tests: `tests/scamPolicy.test.ts` (11), `tests/scamWorkflow.test.ts` (3).
- Demo: `npm run demo:scam`.
- Acceptance met: warning + blocked transfer + simulated verification to the real
  Jake + stored incident (full schema) + caregiver alert + full audit trail.

### Integration honesty (acceptance criterion 12)
- Claude: live with `ANTHROPIC_API_KEY`, else sandbox (deterministic detector runs
  the same policy/tools). The policy engine is identical in both modes.
- Convex: live with `NEXT_PUBLIC_CONVEX_URL`, else in-process store.

## Track 2 — Adversarial red-team harness ✅ done
- `src/redteam/cases.ts` — 34 attack cases across family/bank/official impersonation,
  urgency & secrecy, gift cards, crypto, tech support, prompt injection, data
  exfiltration, callback substitution, multi-turn pressure, fake approval, verifier
  social engineering, and quiet (low-signal) payments.
- `src/redteam/runner.ts` — runs each case through the REAL scam workflow, records
  verdict, which layer defended it (signal / policy / approval), and pass/fail;
  `formatReport` renders a readable Markdown table.
- `scripts/redteam.ts` + `npm run redteam` — prints the report, writes
  `redteam-report.md` (gitignored), exits non-zero on any failure, on <30 cases,
  or on <3 model-level misses.
- Tests: `tests/redteam.test.ts` (5).
- Result: 34/34 defended; 15 model-level misses caught by the deterministic layer
  (requirement ≥3); 2 attacks stopped specifically by the approval gate. No prompt
  tuning: the hardening went into the classifier/policy engine.
- Armadin shown as `unavailable` on the status page (no sponsor API); the suite is
  a local, honest adversarial harness.

## Track 3 — Controlled agent actions (Jira-style) ✅ done
- `src/agents/base/workItems.ts` — WorkItem model (requested action, requesting +
  assigned agent, permission scope, input hash, status requested/in_review/approved/
  rejected/executed/expired, reviewer, timestamps, result, single-use flag, full
  history). `WorkItemStore` interface + `SandboxWorkItemStore`. `WorkItemService`
  lifecycle. `evaluateGate` is the pure, deterministic execution gate.
- Gate enforces ALL of: locally approved, assigned agent, matching tool, matching
  input hash, required reviewer role, not expired, single-use. A synced/external
  "approved" status alone is explicitly rejected (`no_reviewer`).
- `src/integrations/jira.ts` — `JiraWorkItemStore` (same interface) mirrors work
  items to Jira issues (REST v3) for human review; idempotent via the issue key.
  Security-critical state stays in the local mirror and the code gate. Live only
  with ATLASSIAN_* creds; otherwise sandbox. `createWorkItemStore()` picks honestly.
- `jiraStatus()` added to the status page (sandbox without creds).
- Tests: `tests/workItems.test.ts` (9) prove: no-approval, tampered input, expired,
  wrong reviewer role, replayed (single-use), wrong agent, and approved-status-alone
  all fail; the valid path executes exactly once.
- Demo: `npm run demo:approval` (Finance proposes $2,000 → caregiver approves →
  gate executes once; history view printed).

NOTE: the live Jira path is unverified (no Atlassian credentials supplied); it is
written against Jira Cloud REST API v3 and guarded so it never affects the local
gate. Falls back to the fully-tested sandbox store.

### Track 3b: Agent security & coordination (Atlassian) ✅ done
End-to-end: Guardian identifies a task another agent owns, delegates it as a work
item, authorized family reviewers approve, Finance executes only through the gate,
and the result plus a tamper-evident trail sync back (Jira when configured).
- `src/agents/base/workItemPolicy.ts` (PURE): agent capability matrix (who can
  execute which tool/scope), delegation matrix (who may assign what to whom),
  risk tiers (payments >= $1,000 need 2 distinct caregivers), and a
  `ReviewerDirectory` (roles resolved server-side per household, optional Jira
  accountId binding via `ATLASSIAN_REVIEWER_ACCOUNTS="sarah=<id>,david=<id>"`).
- `workItems.ts` additions: per-approval records bound to the input hash and
  expiry; separation of duties (agents, unregistered people, other households and
  duplicate approvers are refused); hash-chained history (`appendEvent`,
  `verifyHistory`); gate also refuses `audit_tampered`, `unbacked_approval`
  (approval with no chained event) and `insufficient_approvals`; approval consumed
  before the executor runs; `applyExternalDecision` accepts a Jira transition only
  from a bound reviewer account (else `external_decision_ignored`), idempotent.
- `jira.ts`: `/search` -> `/search/jql` (410 fix), changelog pull
  (`fetchDecisions`, statuses via `ATLASSIAN_APPROVE_STATUSES` /
  `ATLASSIAN_REJECT_STATUSES`, default Approved,Done / Rejected,Declined,Won't Do),
  Jira comments carry the audit-chain head, process-wide coordinator singleton.
- Tools: Guardian `delegateToAgent`, Finance `executeDelegatedWorkItem`.
- UI: `/approvals` (linked from Activity) + `GET/POST /api/work-items`.
- Tests: `tests/workItems.test.ts` (27). Demo: `npm run demo:approval` (11 checks).
- Limits: sandbox store is in-memory per server process (not shared across
  serverless instances); reviewer identities are sandbox demo identities until
  Auth0 sessions back the directory. Live Jira two-way sync unverified here.

## Track 4 — Elastic incident search ✅ done
- `src/integrations/search.ts` — `IncidentSearchIndex` interface; `InMemorySearchIndex`
  (sandbox, keyword overlap + risk boost) and `ElasticSearchIndex` (live, REST) behind
  it. `redactPII` strips phones/SSNs/amounts/emails before indexing. Search is scoped
  to the caller's own `userId`. Process singleton with a test injection seam.
- Index-after-save job wired into `scamWorkflow` (indexes a PII-redacted summary +
  audits `incident.indexed`). `scamTypeFromSignals` classifies the scam type.
- Guardian tool `searchPastIncidents` (query + channel/scamType filters) answers
  "has someone tried this before?", citing incident ids and snippets, without
  claiming it is the same caller. `indexSeededIncidents` backfills history.
- `elasticStatus()` on the status page (sandbox without creds).
- Tests: `tests/incidentSearch.test.ts` (5) — redaction, correct top-1 for 3 queries
  with cited ids, permission scoping, freshly-screened incident becomes searchable.
- Demo: `npm run demo:search` (top match for the Margaret message + 2 more queries).

## Track 5 — Fetch.ai agent-to-agent messaging ✅ done
- `services/uagents/` — Python bridge: two real uAgents (wellness + guardian) in a
  Bureau exchanging typed `AssistanceRequest` / `AssistanceResponse` messages;
  wellness exposes `POST /assistance` (on_rest_post) and forwards to guardian via
  `ctx.send`; guardian accepts and replies; response correlated by `request_id`.
  `messages.py`, `bridge.py`, `requirements.txt` (uagents==0.26.1), README.
- `src/integrations/fetchai.ts` — typed Zod schemas; `AssistanceBridge` interface
  with `SandboxBridge` (in-process bus, same validation + consent) and
  `FetchAIBridge` (HTTP to the Python service). `requestAssistance` orchestration.
  Only the declared wellness→guardian `assistance.request` event crosses; minimum
  data only (need, urgency, consentRef).
- New declared cross-agent rule + consent key `wellnessToGuardianAssist`; Wellness
  `requestHumanAssistance` tool and planner route for "no one to help".
- `fetchaiStatus()` on the status page.
- Tests: `tests/agentBridge.test.ts` (7) — schema validation, no-consent rejection,
  consent-off rejection, response matches request id, narrow payload only, Wellness
  orchestration + planner routing.
- Demo: `npm run demo:agents`.

VERIFIED LIVE: on this machine (Python 3.13.6), `pip install uagents==0.26.1`
succeeded, the Bureau started both agents, and a real `POST /assistance` returned
`{status: accepted, task_id, request_id}` correlated to the request — confirming
genuine agent-to-agent messaging. The app still defaults to the in-process sandbox
and only switches to the live path when `FETCHAI_BRIDGE_URL` is set (shown honestly
on the status page).

## Definition of done
- All five demos run end to end: `demo:scam`, `redteam`, `demo:approval`,
  `demo:search`, `demo:agents` (all pass with non-zero exit on failure).
- Integration statuses are honest on the status page: Claude (live/sandbox),
  Convex (live/sandbox), Jira (live/sandbox), Elastic (live/sandbox), Fetch.ai
  (live/unavailable), Armadin (unavailable), plus Cartesia/Auth0/Moss.
- Tests pass: 55 across 9 files. `npm run typecheck` and `npm run build` green.

## Missing credentials / unfinished
- No sponsor credentials supplied for Armadin, Atlassian/Jira, or Elastic; those
  run in sandbox/unavailable mode behind their interfaces and activate when creds
  are added. Fetch.ai's live path is verified locally (Python); it is off by
  default and enabled via `FETCHAI_BRIDGE_URL`.
- `npm run lint` is not configured in this repo (no ESLint setup); `npm run
  typecheck` covers static checking.
- The Jira live REST path is written to spec but unverified (no Atlassian creds).

---

# Part 5 — Wellness Agent ✅ done

Built on the merged base (four-agent runtime + Guardian tracks + polished UI).
Reuses the existing audit log, integration-status registry, consent, event bus,
scoped memory and approvals — no infrastructure duplicated.

## Part 5 Track A — Bitdeer structured extraction ✅
- `src/integrations/bitdeer.ts` — `WellnessInferenceProvider` + real
  `BitdeerInferenceAdapter` (OpenAI-compatible, verified endpoints/auth/models) +
  `SandboxWellnessInferenceAdapter`. Provider swappable for tests/demos.
- `src/agents/wellness/observationSchema.ts` — strict zod schema (`.strict()`).
- `src/agents/wellness/privacyFilter.ts` — PII minimization + length cap before
  anything leaves the device.
- `src/agents/wellness/observationPolicy.ts` — PURE deterministic engine: schema,
  injection, medical, evidence grounding, unit/range. Model strictly advisory.
- `src/agents/wellness/extractObservations.ts` — consent-gated pipeline with audit.
- `src/agents/wellness/wellnessStore.ts` — canonical store: provenance, dedup,
  correction (with history), soft-delete.
- Demo: `npm run demo:bitdeer`. Tests: `tests/bitdeer.test.ts` (18).

## Part 5 Track B — Full integration + dashboard ✅
- `src/integrations/{moss,backboard,tigerdata,snowflake}.ts` — each live/sandbox
  behind one interface; factory + test injection hooks like `search.ts`.
- `src/agents/wellness/wellnessWorkflow.ts` — `runWellnessTurn` orchestration;
  external failures degrade safely and are reported honestly (never corrupt Convex).
- `src/agents/wellness/householdAnalytics.ts` — de-identified monthly aggregates,
  authorization, consent withdrawal, monthly report.
- New Wellness tools: `processWellnessConversation`, `reviewRememberedObservations`,
  `correctRememberedObservation`, `forgetRememberedObservation`, `getWellnessTrends`,
  `updateHouseholdAnalytics`. `AgentService.runTool` added for agent-specific UIs.
- `src/app/wellness/page.tsx` + `src/app/api/wellness/{dashboard,observation}` —
  the Unified Wellness Dashboard, verified rendering + actions against a live dev
  server (message → extraction → dashboard → correct → analytics sync).
- Demos: `demo:wellness-memory`, `demo:backboard`, `demo:tigerdata`,
  `demo:snowflake`, `demo:wellness-full`. Tests: `tests/wellnessIntegration.test.ts` (8).

## Part 5 Track C — Red-team ✅
- `src/redteam/wellnessCases.ts` (32 cases), `wellnessRunner.ts`,
  `scripts/redteam-wellness.ts`. `npm run redteam:wellness` → 32/32 defended,
  exits non-zero on any failure or <30 cases. Tests: `tests/wellnessRedteam.test.ts` (4).

## Part 5 verification
- `npm run typecheck` green. `npm test` = 90 tests across 13 files (was 60 base).
- `npm run build` green (Next 15.5.28); routes `/wellness`, `/api/wellness/*` present.
- All six Part 5 demos pass; `redteam:wellness` 32/32.
- Regression: Guardian/Care/Finance demos still pass; `npm run redteam` 34/34.

## Integration honesty (Part 5)
- Bitdeer: live with `BITDEER_API_KEY`, else sandbox (deterministic extractor). The
  strict schema + evidence grounding are identical in both modes.
- Moss / Backboard / Tiger Data / Snowflake: live with their creds, else a sandbox
  with the same interface (nothing leaves the device). No sponsor creds supplied
  here, so all show sandbox; the live code paths activate when creds are added and
  are written to each provider's documented REST shape (live paths UNVERIFIED
  without creds).
