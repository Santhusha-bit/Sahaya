"use client";

import { useEffect, useState } from "react";

interface Entry {
  seq: number;
  ts: number;
  agent: string;
  event: string;
  detail: string;
  request_id: string;
}
interface Peer {
  agent: string;
  address: string;
  reachable: boolean;
}

const AGENT_COLOR: Record<string, string> = {
  guardian: "#168b82",
  care: "#4779b8",
  wellness: "#c98a2e",
  finance: "#5a6acf",
};

/** Live execution logs of the Fetch.ai uAgents, polled while the page is open. */
export function AgentNetworkLog() {
  const [live, setLive] = useState<boolean | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await (await fetch("/api/bridge/logs", { cache: "no-store" })).json();
        if (stop) return;
        setLive(d.live);
        setPeers(d.agents ?? []);
        setEntries(d.entries ?? []);
      } catch {
        /* keep the last view */
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (live === null || live === false) return null;

  return (
    <section className="card mt-5 p-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        <h2 className="text-[15px] font-bold">Fetch.ai agent network</h2>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {peers.map((p) => (
          <span
            key={p.agent}
            title={p.address}
            className="pill px-2 py-0.5 text-[11px] font-semibold"
            style={{ background: `${AGENT_COLOR[p.agent]}18`, color: p.reachable ? AGENT_COLOR[p.agent] : "#9ca3af" }}
          >
            {p.agent} {p.reachable ? `${p.address.slice(0, 10)}...` : "offline"}
          </span>
        ))}
      </div>
      <ol className="mt-3 flex max-h-80 flex-col gap-1 overflow-y-auto font-mono text-[11px] leading-snug">
        {entries.length === 0 && <li className="text-[var(--faint)]">No messages yet. Ask Wellness for help with groceries.</li>}
        {entries.map((e) => (
          <li key={`${e.agent}-${e.seq}`} className="fade-up">
            <span className="text-[var(--faint)]">{new Date(e.ts * 1000).toLocaleTimeString()} </span>
            <span className="font-bold" style={{ color: AGENT_COLOR[e.agent] }}>
              {e.agent}
            </span>{" "}
            <span className="font-semibold">{e.event}</span> <span className="text-[var(--muted)]">{e.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
