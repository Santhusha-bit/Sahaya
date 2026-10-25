"""Typed messages exchanged between the Sahaya uAgents.

These mirror the TypeScript Zod schemas in src/integrations/fetchai.ts so the same
contract holds on both sides of the bridge. Only these fields ever cross; no
conversation content is transmitted.

Note: uagents' `Model` is not a plain pydantic BaseModel and does not apply field
aliases, so the sender/recipient fields are named `from_agent` / `to_agent` (the
Python keyword `from` cannot be a field name). The TS side uses the same names.
"""

from uagents import Model


class AssistanceRequest(Model):
    """Wellness / Care / Finance -> Guardian: please coordinate a human helper."""

    request_id: str
    from_agent: str  # "wellness" | "care" | "finance"
    to_agent: str  # always "guardian"
    user_id: str
    need: str
    consent_ref: str
    urgency: str  # "routine" | "soon" | "urgent"


class AssistanceResponse(Model):
    """Guardian -> requester: accepted (with a task id) or rejected (with a reason)."""

    request_id: str
    task_id: str
    status: str  # "accepted" | "rejected"
    reason: str = ""
    task_status: str = ""  # Guardian task state, e.g. "in_progress"
    coordinator: str = ""  # uAgent address of the Guardian that handled it


class LogEntry(Model):
    seq: int
    ts: float
    agent: str
    event: str
    detail: str = ""
    request_id: str = ""


class LogsResponse(Model):
    agent: str
    address: str
    entries: list[LogEntry]
