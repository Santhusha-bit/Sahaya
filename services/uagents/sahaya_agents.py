"""Shared runtime for the Sahaya uAgents.

Each Sahaya agent (wellness, care, finance, guardian) runs as its OWN uAgent in
its OWN process with its own seed-derived identity, port and /submit endpoint.
Messages between them are real uAgents envelopes (signed by the sender, verified
by the receiver), not function calls.

Network modes (SAHAYA_UAGENTS_NETWORK):
  local (default)  Peers are resolved from the table below (RulesBasedResolver) and
                   Almanac registration is skipped, so the demo needs no internet,
                   wallet or Agentverse account.
  almanac          Default uAgents registration + global resolution (Almanac API /
                   Agentverse). Set AGENTVERSE_MAILBOX=1 to also use an Agentverse
                   mailbox. Requires network access; not exercised by the tests.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from uagents import Agent
from uagents.crypto import Identity
from uagents.resolver import GlobalResolver, RulesBasedResolver
from uagents_core.registration import AgentRegistrationPolicy

from messages import LogEntry, LogsResponse

HOST = os.environ.get("SAHAYA_UAGENTS_HOST", "127.0.0.1")

# name -> default port. Ports are overridable with UAGENT_PORT_<NAME>.
PEERS: dict[str, int] = {
    "wellness": 8020,
    "guardian": 8021,
    "care": 8022,
    "finance": 8023,
}

REQUESTERS = ("wellness", "care", "finance")

LOG_DIR = Path(__file__).resolve().parent / "logs"


def port_of(name: str) -> int:
    return int(os.environ.get(f"UAGENT_PORT_{name.upper()}", PEERS[name]))


def seed_of(name: str) -> str:
    # Demo seeds are deterministic so peers can compute each other's address.
    # Override per agent with UAGENT_SEED_<NAME> for anything beyond a local demo.
    return os.environ.get(f"UAGENT_SEED_{name.upper()}", f"sahaya-{name}-uagent-seed-v1")


def address_of(name: str) -> str:
    return Identity.from_seed(seed_of(name), 0).address


def endpoint_of(name: str) -> str:
    return f"http://{HOST}:{port_of(name)}/submit"


class LocalOnlyRegistration(AgentRegistrationPolicy):
    """Skip Almanac registration: peers are resolved from the local table."""

    async def register(self, agent_identifier, identity, protocols, endpoints, metadata=None):
        return None


def network_mode() -> str:
    return os.environ.get("SAHAYA_UAGENTS_NETWORK", "local").strip().lower()


def exit_with_parent() -> None:
    """When launched by bridge.py (or the TS demo), exit as soon as the parent dies.

    The parent holds our stdin open; EOF means it is gone. Without this, Windows
    leaves orphaned agents holding their ports after the launcher is killed.
    """
    if os.environ.get("SAHAYA_EXIT_WITH_PARENT") != "1":
        return

    def watch() -> None:
        try:
            sys.stdin.read()
        finally:
            os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def make_agent(name: str) -> Agent:
    exit_with_parent()
    kwargs: dict[str, Any] = dict(
        name=f"sahaya_{name}",
        seed=seed_of(name),
        port=port_of(name),
        endpoint=[endpoint_of(name)],
        enable_agent_inspector=False,
    )
    if network_mode() == "almanac":
        kwargs["resolve"] = GlobalResolver()
        kwargs["network"] = "testnet"
        if os.environ.get("AGENTVERSE_MAILBOX") == "1":
            kwargs["mailbox"] = True
    else:
        rules = {address_of(peer): endpoint_of(peer) for peer in PEERS if peer != name}
        kwargs["resolve"] = RulesBasedResolver(rules)
        kwargs["registration_policy"] = LocalOnlyRegistration()
        kwargs["publish_agent_details"] = False
    return Agent(**kwargs)


class ExecLog:
    """Execution log for one agent: in-memory ring (served at GET /logs) + JSONL file."""

    def __init__(self, agent_name: str, maxlen: int = 300):
        self.agent = agent_name
        self._entries: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._seq = 0
        LOG_DIR.mkdir(exist_ok=True)
        self._file = LOG_DIR / f"{agent_name}.jsonl"

    def write(self, logger, event: str, detail: str = "", request_id: str = "") -> None:
        self._seq += 1
        entry = {
            "seq": self._seq,
            "ts": time.time(),
            "agent": self.agent,
            "event": event,
            "detail": detail,
            "request_id": request_id,
        }
        self._entries.append(entry)
        with self._file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        logger.info(f"[{event}] {detail}" + (f" (req {request_id})" if request_id else ""))

    def response(self, address: str, since: int = 0) -> LogsResponse:
        return LogsResponse(
            agent=self.agent,
            address=address,
            entries=[LogEntry(**e) for e in self._entries if e["seq"] > since],
        )
