"""Guardian uAgent: receives AssistanceRequest messages and starts helper coordination.

Runs as its own process (python guardian_agent.py) with its own identity.

On each request it:
  1. verifies the envelope's cryptographic sender is the agent the message claims
     to come from (a Care agent cannot pose as Wellness),
  2. checks consent_ref / urgency / need at the edge,
  3. hands the request to the TypeScript Guardian agent (GUARDIAN_AGENT_URL), which
     runs its real policy + bus checks and creates the coordination task,
  4. replies to the requester with the task id and status.

The TypeScript Guardian stays authoritative for the task. If it is unreachable,
the uAgent replies "rejected" with reason "guardian_agent_unreachable" rather than
inventing a task.
"""

from __future__ import annotations

import os

import aiohttp
from uagents import Context

from kinline_agents import REQUESTERS, ExecLog, address_of, make_agent
from messages import AssistanceRequest, AssistanceResponse, LogsResponse

NAME = "guardian"
GUARDIAN_AGENT_URL = os.environ.get("GUARDIAN_AGENT_URL", "http://127.0.0.1:3000/api/bridge/guardian").rstrip("/")
BRIDGE_TOKEN = os.environ.get("KINLINE_BRIDGE_TOKEN", "")
URGENCIES = {"routine", "soon", "urgent"}

agent = make_agent(NAME)
log = ExecLog(NAME)

# Idempotency: a re-delivered request gets the same answer, never a second task.
_handled: dict[str, AssistanceResponse] = {}


def short(addr: str) -> str:
    return f"{addr[:14]}...{addr[-6:]}"


def reject(msg: AssistanceRequest, reason: str) -> AssistanceResponse:
    return AssistanceResponse(request_id=msg.request_id, task_id="", status="rejected", reason=reason,
                              coordinator=agent.address)


async def coordinate(ctx: Context, msg: AssistanceRequest) -> AssistanceResponse:
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["x-kinline-bridge-token"] = BRIDGE_TOKEN
    payload = msg.dict() if hasattr(msg, "dict") else msg.model_dump()
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{GUARDIAN_AGENT_URL}/assistance", json=payload, headers=headers) as res:
                body = await res.json(content_type=None)
                if res.status != 200:
                    return reject(msg, body.get("reason") or f"guardian_agent_http_{res.status}")
    except Exception as exc:  # noqa: BLE001 - any transport failure is reported, not hidden
        log.write(ctx.logger, "guardian_agent.unreachable", f"{GUARDIAN_AGENT_URL}: {type(exc).__name__}", msg.request_id)
        return reject(msg, "guardian_agent_unreachable")

    if body.get("status") != "accepted":
        return reject(msg, body.get("reason") or "guardian_rejected")
    return AssistanceResponse(
        request_id=msg.request_id,
        task_id=str(body.get("task_id", "")),
        status="accepted",
        task_status=str(body.get("task_status", "")),
        coordinator=agent.address,
    )


@agent.on_message(model=AssistanceRequest, replies={AssistanceResponse})
async def on_request(ctx: Context, sender: str, msg: AssistanceRequest) -> None:
    log.write(ctx.logger, "message.received",
              f"AssistanceRequest from {msg.from_agent} ({short(sender)}): need={msg.need!r} urgency={msg.urgency}",
              msg.request_id)

    if msg.request_id in _handled:
        log.write(ctx.logger, "request.duplicate", "re-sending earlier response", msg.request_id)
        await ctx.send(sender, _handled[msg.request_id])
        return

    if msg.from_agent not in REQUESTERS or msg.to_agent != NAME:
        response = reject(msg, "undeclared_route")
    elif sender != address_of(msg.from_agent):
        response = reject(msg, "sender_identity_mismatch")
    elif not msg.consent_ref:
        response = reject(msg, "missing_consent_ref")
    elif msg.urgency not in URGENCIES or not msg.need or len(msg.need) > 300:
        response = reject(msg, "invalid_request")
    else:
        log.write(ctx.logger, "request.accepted_at_edge",
                  f"sender verified as {msg.from_agent}; handing to Guardian agent", msg.request_id)
        response = await coordinate(ctx, msg)

    if response.status == "accepted":
        log.write(ctx.logger, "coordination.started",
                  f"task {response.task_id} ({response.task_status or 'in_progress'})", msg.request_id)
        _handled[msg.request_id] = response
    else:
        log.write(ctx.logger, "request.rejected", response.reason, msg.request_id)

    await ctx.send(sender, response)
    log.write(ctx.logger, "message.sent",
              f"AssistanceResponse to {msg.from_agent}: status={response.status}"
              + (f" task={response.task_id}" if response.task_id else ""),
              msg.request_id)


@agent.on_rest_get("/logs", LogsResponse)
async def logs(_ctx: Context) -> LogsResponse:
    return log.response(agent.address)


@agent.on_event("startup")
async def startup(ctx: Context) -> None:
    log.write(ctx.logger, "agent.started", f"guardian uAgent {short(agent.address)} -> TS Guardian at {GUARDIAN_AGENT_URL}")


if __name__ == "__main__":
    agent.run()
