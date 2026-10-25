# Fetch.ai uAgents: real agent-to-agent messaging

Guardian, Wellness, Care and Finance each get their **own uAgent**, running as a
**separate OS process** with its own seed-derived identity, port and `/submit`
endpoint. Cross-agent requests travel as signed uAgents envelopes between those
processes. The TypeScript agents stay authoritative: they decide, the uAgents
carry the messages.

```
TS Wellness ──POST /assistance──▶ wellness uAgent (:8020)
                                       │  AssistanceRequest (signed envelope)
                                       ▼
                                  guardian uAgent (:8021)
                                       │  1. verify envelope sender == claimed from_agent
                                       │  2. consent_ref / urgency / need checks
                                       ▼
                     POST {GUARDIAN_AGENT_URL}/assistance ──▶ TS Guardian
                                       │  bus policy + consent, creates the task
                                       ▼
                                  AssistanceResponse {task_id, status, task_status}
                                       │  (signed envelope back)
                                       ▼
TS Wellness ◀── task id + status ── wellness uAgent ──▶ Wellness tells the person
```

| Agent    | Script                          | Port | TS env var that points at it           |
|----------|---------------------------------|------|----------------------------------------|
| guardian | `guardian_agent.py`             | 8021 | (calls `GUARDIAN_AGENT_URL`)           |
| wellness | `requester_agent.py wellness`   | 8020 | `FETCHAI_WELLNESS_URL` (or `FETCHAI_BRIDGE_URL`) |
| care     | `requester_agent.py care`       | 8022 | `FETCHAI_CARE_URL`                     |
| finance  | `requester_agent.py finance`    | 8023 | `FETCHAI_FINANCE_URL`                  |

## The demo (one command)

```bash
pip install -r services/uagents/requirements.txt
npm run demo:a2a
```

It hosts the TS Guardian intake, spawns the Wellness and Guardian uAgents as two
processes, and plays the scenario: Margaret says *"I don't have anyone to help me
get groceries"*, Wellness asks permission (a code-enforced approval), she approves,
Wellness's uAgent messages Guardian's uAgent, Guardian creates the coordination
task and replies with its id and status, and Wellness reports back. Both agents'
execution logs stream live in the terminal while the message is exchanged. Exits
non-zero if any hop fails. First start can take ~30s while Python imports uagents.

Ports busy? `UAGENT_PORT_WELLNESS=8120 UAGENT_PORT_GUARDIAN=8121 GUARDIAN_INTAKE_PORT=8131 npm run demo:a2a`

## With the web app

```bash
# terminal 1: the four uAgents (each its own process, logs interleaved)
cd services/uagents && python bridge.py
#   (Guardian forwards to the Next app by default: GUARDIAN_AGENT_URL=http://127.0.0.1:3000/api/bridge/guardian)

# terminal 2: the app, pointed at the uAgents (.env.local)
FETCHAI_WELLNESS_URL=http://127.0.0.1:8020
FETCHAI_CARE_URL=http://127.0.0.1:8022
FETCHAI_FINANCE_URL=http://127.0.0.1:8023
npm run dev
```

Then tell Wellness *"I don't have anyone to help me get groceries"*, tap **Approve**,
and watch the **Activity** page: its *Fetch.ai agent network* panel polls every
agent's `GET /logs` and updates live. The task appears on Guardian's page.
`/api/status` shows Fetch.ai as **live**.

Guardian can also forward to the standalone Guardian service instead of the app:
`npm run serve:guardian` then `GUARDIAN_AGENT_URL=http://127.0.0.1:8030 python bridge.py`.

## Security properties (enforced in code)

- **Permission first.** Wellness's `requestHumanAssistance` tool has
  `requiresApproval: true`; nothing is sent until the person approves.
- **Sender identity.** Guardian rejects a request whose signed envelope sender is
  not the uAgent of the `from_agent` it claims (`sender_identity_mismatch`), and a
  requester uAgent only speaks for its own TS agent (`undeclared_route`).
- **Declared routes + consent.** The TS Guardian intake runs the same
  `CROSS_AGENT_RULES` bus policy and per-user consent as the in-process path
  (`wellnessToGuardianAssist`, `careToGuardian`, `financeToGuardianAssist`).
- **Minimum data.** Only `need`, `urgency` and a consent reference cross; never a
  conversation. The bus persists only the schema-validated payload.
- **Idempotent.** A re-delivered `request_id` gets the original answer, not a second task.
- **Intake auth.** Set `KINLINE_BRIDGE_TOKEN` on both sides to require the
  `x-kinline-bridge-token` header; without it the app endpoint refuses to run in production.
- **Honest labeling.** No uAgent URL configured: the identical exchange runs
  in-process and is labeled sandbox, never "Fetch.ai". A configured bridge that is
  down is reported as a rejection, not silently swapped for the sandbox.

## Execution logs

Each agent logs every hop (`rest.request`, `message.sent`, `message.received`,
`request.accepted_at_edge`, `coordination.started`, `request.rejected`, ...) to
stdout, to `services/uagents/logs/<agent>.jsonl`, and at `GET http://127.0.0.1:<port>/logs`.

## Network modes

`KINLINE_UAGENTS_NETWORK=local` (default) resolves peers from a local table and
skips Almanac registration, so the demo needs no internet, wallet or Agentverse
account. `KINLINE_UAGENTS_NETWORK=almanac` uses standard uAgents registration and
global resolution (set `AGENTVERSE_MAILBOX=1` for an Agentverse mailbox); that mode
needs network access and is not exercised by the tests. Demo seeds are
deterministic; override with `UAGENT_SEED_<AGENT>` beyond a local demo.

## Contract

`messages.py` mirrors the Zod schemas in `src/integrations/fetchai.ts`:

- `AssistanceRequest { request_id, from_agent, to_agent, user_id, need, consent_ref, urgency }`
- `AssistanceResponse { request_id, task_id, status, reason, task_status, coordinator }`

uagents' `Model` ignores field aliases, so the wire names are `from_agent` / `to_agent`.

## Verification

Verified locally with Python 3.13 and uagents 0.26.1: `npm run demo:a2a` passes
end to end (two processes, signed message each way, Guardian task created).
`npm test` covers the TS side (approval gate, Guardian intake, consent, spoofing,
live HTTP bridge against a fake uAgent, unreachable bridge).
