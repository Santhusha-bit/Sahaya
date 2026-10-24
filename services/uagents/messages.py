"""Typed messages exchanged between the two uAgents (Track 5).

These mirror the TypeScript Zod schemas in src/integrations/fetchai.ts so the same
contract holds on both sides of the bridge. Only these fields ever cross; no
conversation content is transmitted.

Note: uagents' `Model` is not a plain pydantic BaseModel and does not apply field
aliases, so the sender/recipient fields are named `from_agent` / `to_agent` (the
Python keyword `from` cannot be a field name). The TS side uses the same names.
"""

from uagents import Model


class AssistanceRequest(Model):
    request_id: str
    from_agent: str
    to_agent: str
    user_id: str
    need: str
    consent_ref: str
    urgency: str


class AssistanceResponse(Model):
    request_id: str
    task_id: str
    status: str  # "accepted" | "rejected"
    reason: str = ""
