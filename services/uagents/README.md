# Fetch.ai uAgents bridge (Track 5)

Two real uAgents that exchange typed messages for the Wellness → Guardian
"human assistance" workflow. The TypeScript agents stay authoritative; this
service is the optional live transport.

## Run

```bash
cd services/uagents
pip install -r requirements.txt
python bridge.py
```

Then point the app at it:

```bash
# in .env.local
FETCHAI_BRIDGE_URL=http://localhost:8020
```

With that set, `createAssistanceBridge()` (src/integrations/fetchai.ts) posts the
typed `AssistanceRequest` to `POST /assistance` and the status page shows Fetch.ai
as **live**. Without it, the app runs the identical exchange on the in-process bus
and labels the integration **unavailable** (never "Fetch.ai").

## Contract

`messages.py` mirrors the Zod schemas in `src/integrations/fetchai.ts`:

- `AssistanceRequest { request_id, from, to, user_id, need, consent_ref, urgency }`
- `AssistanceResponse { request_id, task_id, status, reason? }`

Only these fields cross the bridge — never conversation content. The response is
correlated to the request by `request_id`, and a request without a `consent_ref`
is rejected at the edge.

## Verification status

Written against the uAgents 0.26.1 docs (`on_rest_post`, `Model`, `Bureau`,
`ctx.send`/`on_message`). It has NOT been run in this environment (no Python
runtime was available here), so it is treated as the unverified live path and the
app defaults to the tested in-process sandbox. See PROGRESS.md.
