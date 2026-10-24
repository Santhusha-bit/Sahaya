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

## Track 4 — Elastic incident search ⏳ next
## Track 5 — Fetch.ai agent-to-agent messaging ⏳ todo

## Missing credentials / unfinished
- No sponsor credentials provided yet (Armadin, Atlassian/Jira, Elastic, Fetch.ai).
  Each track ships a sandbox implementation behind an interface and is labeled
  honestly; live adapters activate when credentials are supplied.
