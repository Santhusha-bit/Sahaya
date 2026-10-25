"""Launch the four Kinline uAgents, each as its own OS process.

    python bridge.py            # guardian + wellness + care + finance
    python bridge.py wellness   # guardian + wellness only

Output from every agent is interleaved here with a [name] prefix, so the live
execution logs of both sides of an exchange are visible in one terminal. Each
agent also serves its log at GET http://127.0.0.1:<port>/logs. Ctrl+C stops all.

You can equally start them yourself in separate terminals:
    python guardian_agent.py
    python requester_agent.py wellness
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from kinline_agents import REQUESTERS, address_of, exit_with_parent, port_of

HERE = Path(__file__).resolve().parent
COLORS = {"guardian": "\033[94m", "wellness": "\033[93m", "care": "\033[92m", "finance": "\033[95m"}
RESET = "\033[0m"


def pump(name: str, proc: subprocess.Popen) -> None:
    for line in proc.stdout:  # type: ignore[union-attr]
        print(f"{COLORS[name]}[{name:>8}]{RESET} {line.rstrip()}", flush=True)


def main() -> None:
    exit_with_parent()  # only active when our own launcher asked for it
    requested = [a for a in sys.argv[1:] if a in REQUESTERS] or list(REQUESTERS)
    plan = [("guardian", ["guardian_agent.py"])] + [(n, ["requester_agent.py", n]) for n in requested]
    procs: list[subprocess.Popen] = []
    for name, args in plan:
        print(f"starting {name:>8} on :{port_of(name)}  {address_of(name)}")
        proc = subprocess.Popen([sys.executable, "-u", *args], cwd=HERE, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                errors="replace", env={**os.environ, "KINLINE_EXIT_WITH_PARENT": "1"})
        procs.append(proc)
        threading.Thread(target=pump, args=(name, proc), daemon=True).start()
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
        print("an agent exited; stopping the rest")
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
