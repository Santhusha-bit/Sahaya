"""Fetch.ai uAgents bridge (Track 5) — the LIVE agent-to-agent path.

Two real uAgents run in one Bureau and exchange typed messages:

  wellness_bridge  - exposes POST /assistance (called by the TS Wellness agent),
                     forwards an AssistanceRequest to the guardian agent, and
                     returns the guardian's AssistanceResponse.
  guardian_bridge  - receives AssistanceRequest, "accepts" it (coordinates a
                     helper), and replies with AssistanceResponse.

Run:  pip install -r requirements.txt  &&  python bridge.py
Then set FETCHAI_BRIDGE_URL=http://localhost:8020 for the TS app so it posts here.

Verified against uagents 0.26.1 docs (on_rest_post + Model + Bureau). If Python or
uagents is unavailable, the TS app falls back to the in-process bus and labels the
integration "unavailable" (never "Fetch.ai").
"""

import asyncio
import uuid

from uagents import Agent, Bureau, Context

from messages import AssistanceRequest, AssistanceResponse

WELLNESS_PORT = 8020
GUARDIAN_PORT = 8021

wellness = Agent(name="wellness_bridge", seed="kinline-wellness-bridge-seed", port=WELLNESS_PORT,
                 endpoint=[f"http://localhost:{WELLNESS_PORT}/submit"])
guardian = Agent(name="guardian_bridge", seed="kinline-guardian-bridge-seed", port=GUARDIAN_PORT,
                 endpoint=[f"http://localhost:{GUARDIAN_PORT}/submit"])

# Correlate the async guardian reply back to the waiting REST request by request_id.
_pending: dict[str, asyncio.Future] = {}


@wellness.on_rest_post("/assistance", AssistanceRequest, AssistanceResponse)
async def handle_assistance(ctx: Context, req: AssistanceRequest) -> AssistanceResponse:
    # Enforce consent at the edge too: no consent reference -> reject.
    if not req.consent_ref:
        return AssistanceResponse(request_id=req.request_id, task_id="", status="rejected",
                                  reason="missing_consent_ref")

    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    _pending[req.request_id] = fut

    await ctx.send(guardian.address, req)
    try:
        return await asyncio.wait_for(fut, timeout=10)
    except asyncio.TimeoutError:
        _pending.pop(req.request_id, None)
        return AssistanceResponse(request_id=req.request_id, task_id="", status="rejected",
                                  reason="guardian_timeout")


@guardian.on_message(model=AssistanceRequest)
async def on_request(ctx: Context, sender: str, msg: AssistanceRequest) -> None:
    ctx.logger.info(f"Guardian received assistance request {msg.request_id}: {msg.need}")
    # Accept and coordinate a helper (task id stands in for the coordination task).
    task_id = f"task_{uuid.uuid4().hex[:12]}"
    await ctx.send(sender, AssistanceResponse(request_id=msg.request_id, task_id=task_id, status="accepted"))


@wellness.on_message(model=AssistanceResponse)
async def on_response(ctx: Context, sender: str, msg: AssistanceResponse) -> None:
    fut = _pending.pop(msg.request_id, None)
    if fut and not fut.done():
        fut.set_result(msg)


# The Bureau runs one HTTP server for both agents; the REST endpoint is served on
# the Bureau's port. Point FETCHAI_BRIDGE_URL at this port.
BRIDGE_PORT = 8020
bureau = Bureau(port=BRIDGE_PORT, endpoint=[f"http://localhost:{BRIDGE_PORT}/submit"])
bureau.add(wellness)
bureau.add(guardian)


if __name__ == "__main__":
    bureau.run()
