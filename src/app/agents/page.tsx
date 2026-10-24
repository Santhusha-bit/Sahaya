import { AgentCard } from "@/components/AgentCard";
import { agentMeta, AGENT_IDS } from "@/agents/registry";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  const meta = agentMeta();
  return (
    <main className="px-5 pt-10">
      <h1 className="text-[26px] font-bold">Your agents</h1>
      <p className="mt-1 text-[15px] text-[var(--muted)]">
        Four independent AI agents. Each has its own memory, tools, and voice.
      </p>
      <section className="mt-5 flex flex-col gap-3">
        {AGENT_IDS.map((id) => (
          <div key={id}>
            <AgentCard meta={meta[id]} />
            <div className="mt-1 px-2 text-[12px] text-[var(--muted)]">
              {meta[id].toolNames.length} tools · {meta[id].toolNames.slice(0, 3).join(", ")}…
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
