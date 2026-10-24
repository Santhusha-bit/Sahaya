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

## Track 2 — Adversarial red-team harness ⏳ next
## Track 3 — Controlled agent actions (Jira-style) ⏳ todo
## Track 4 — Elastic incident search ⏳ todo
## Track 5 — Fetch.ai agent-to-agent messaging ⏳ todo

## Missing credentials / unfinished
- No sponsor credentials provided yet (Armadin, Atlassian/Jira, Elastic, Fetch.ai).
  Each track ships a sandbox implementation behind an interface and is labeled
  honestly; live adapters activate when credentials are supplied.
