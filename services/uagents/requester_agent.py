"""Requester uAgent for Wellness, Care or Finance.

    python requester_agent.py wellness   # port 8020
    python requester_agent.py care       # port 8022
    python requester_agent.py finance    # port 8023

Each runs as its own process with its own identity. The TypeScript agent of the
same name calls POST /assistance on it; the uAgent sends a signed AssistanceRequest
envelope to the Guardian uAgent and returns Guardian's AssistanceResponse.
"""

from __future__ import annotations

import asyncio
import sys

from uagents import Context

from sahaya_agents import REQUESTERS, ExecLog, address_of, make_agent
from messages import AssistanceRequest, AssistanceResponse, LogsResponse

NAME = sys.argv[1] if len(sys.argv) > 1 else "wellness"
if NAME not in REQUESTERS:
    sys.exit(f"usage: requester_agent.py {{{'|'.join(REQUESTERS)}}}")

GUARDIAN = address_of("guardian")
REPLY_TIMEOUT_S = 20

agent = make_agent(NAME)
log = ExecLog(NAME)

# Correlate Guardian's async reply back to the waiting REST call by request_id.
_pending: dict[str, asyncio.Future] = {}


def rejected(req: AssistanceRequest, reason: str) -> AssistanceResponse:
    return AssistanceResponse(request_id=req.request_id, task_id="", status="rejected", reason=reason)


@agent.on_rest_post("/assistance", AssistanceRequest, AssistanceResponse)
async def handle_assistance(ctx: Context, req: AssistanceRequest) -> AssistanceResponse:
    log.write(ctx.logger, "rest.request", f"{NAME} TS agent asked for help: need={req.need!r}", req.request_id)

    # This uAgent only speaks for its own TS agent, and only to Guardian.
    if req.from_agent != NAME or req.to_agent != "guardian":
        log.write(ctx.logger, "request.rejected", "undeclared_route", req.request_id)
        return rejected(req, "undeclared_route")
    if not req.consent_ref:
        log.write(ctx.logger, "request.rejected", "missing_consent_ref", req.request_id)
        return rejected(req, "missing_consent_ref")

    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending[req.request_id] = fut
    await ctx.send(GUARDIAN, req)
    log.write(ctx.logger, "message.sent", f"AssistanceRequest -> guardian ({GUARDIAN[:14]}...)", req.request_id)
    try:
        res: AssistanceResponse = await asyncio.wait_for(fut, timeout=REPLY_TIMEOUT_S)
    except asyncio.TimeoutError:
        _pending.pop(req.request_id, None)
        log.write(ctx.logger, "request.timeout", f"no reply from guardian in {REPLY_TIMEOUT_S}s", req.request_id)
        return rejected(req, "guardian_timeout")
    log.write(ctx.logger, "rest.response", f"returned status={res.status} to {NAME} TS agent", req.request_id)
    return res


@agent.on_message(model=AssistanceResponse)
async def on_response(ctx: Context, sender: str, msg: AssistanceResponse) -> None:
    if sender != GUARDIAN:
        log.write(ctx.logger, "message.ignored", f"AssistanceResponse from non-guardian {sender[:14]}...", msg.request_id)
        return
    log.write(ctx.logger, "message.received",
              f"AssistanceResponse from guardian: status={msg.status}"
              + (f" task={msg.task_id} ({msg.task_status})" if msg.task_id else f" reason={msg.reason}"),
              msg.request_id)
    fut = _pending.pop(msg.request_id, None)
    if fut and not fut.done():
        fut.set_result(msg)


@agent.on_rest_get("/logs", LogsResponse)
async def logs(_ctx: Context) -> LogsResponse:
    return log.response(agent.address)


@agent.on_event("startup")
async def startup(ctx: Context) -> None:
    log.write(ctx.logger, "agent.started", f"{NAME} uAgent {agent.address[:14]}... ready; guardian={GUARDIAN[:14]}...")


if __name__ == "__main__":
    agent.run()
