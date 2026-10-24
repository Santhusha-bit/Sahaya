import { AgentCard } from "@/components/AgentCard";
import { agentMeta, AGENT_IDS } from "@/agents/registry";

export const dynamic = "force-dynamic";

export default function AgentsPage() {
  const meta = agentMeta();
  return (
    <main className="px-5 pt-8">
      <h1 className="text-[28px] font-extrabold tracking-tight">Your agents</h1>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Four independent AI agents. Each has its own memory, tools, and voice.
      </p>
      <section className="mt-5 flex flex-col gap-3">
        {AGENT_IDS.map((id, i) => (
          <div key={id} className={`stagger-${Math.min(i + 1, 4)}`}>
            <AgentCard meta={meta[id]} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 px-2">
              <span className="pill bg-[var(--bg-tint)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted)]">
                {meta[id].toolNames.length} tools
              </span>
              {meta[id].toolNames.slice(0, 3).map((t) => (
                <span key={t} className="pill bg-[var(--bg-tint)] px-2 py-0.5 text-[11px] text-[var(--faint)]">
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
