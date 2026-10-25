import { NextResponse } from "next/server";
import { REQUESTER_AGENTS, bridgeUrlFor } from "@/integrations/fetchai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LogEntry {
  seq: number;
  ts: number;
  agent: string;
  event: string;
  detail: string;
  request_id: string;
}

/**
 * Merged execution logs of the running uAgents (each serves GET /logs), for the
 * Activity page's live agent-network view. Only agents with a configured URL are
 * queried; Guardian's uAgent is FETCHAI_GUARDIAN_URL (default :8021).
 */
export async function GET() {
  const targets = REQUESTER_AGENTS.map((agent) => ({ agent, url: bridgeUrlFor(agent) })).filter(
    (t): t is { agent: (typeof REQUESTER_AGENTS)[number]; url: string } => !!t.url,
  );
  if (targets.length === 0) return NextResponse.json({ live: false, agents: [], entries: [] });

  const all = [
    ...targets,
    { agent: "guardian", url: process.env.FETCHAI_GUARDIAN_URL?.trim() || "http://127.0.0.1:8021" },
  ];
  const results = await Promise.all(
    all.map(async ({ agent, url }) => {
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/logs`, { cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { address: string; entries: LogEntry[] };
        return { agent, address: body.address, reachable: true, entries: body.entries };
      } catch {
        return { agent, address: "", reachable: false, entries: [] as LogEntry[] };
      }
    }),
  );
  const entries = results
    .flatMap((r) => r.entries)
    .sort((a, b) => a.ts - b.ts)
    .slice(-80);
  return NextResponse.json({
    live: true,
    agents: results.map(({ agent, address, reachable }) => ({ agent, address, reachable })),
    entries,
  });
}
