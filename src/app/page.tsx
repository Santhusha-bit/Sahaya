import Link from "next/link";
import { AgentCard } from "@/components/AgentCard";
import { agentMeta, AGENT_IDS } from "@/agents/registry";
import { getCurrentUser } from "@/lib/user";
import { getDataLayer } from "@/agents/base/dataLayer";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const meta = agentMeta();
  const user = getCurrentUser();
  const backend = getDataLayer().backend;

  return (
    <main className="px-5 pt-10">
      <header className="mb-6">
        <div className="text-[13px] font-semibold uppercase tracking-wide text-[var(--muted)]">Kinline</div>
        <h1 className="mt-1 text-[28px] font-bold leading-tight">Hello, {user.name}.</h1>
        <p className="mt-1 text-[15px] text-[var(--muted)]">
          Four caring helpers, each here for a different part of your day. Tap one to talk.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        {AGENT_IDS.map((id) => (
          <AgentCard key={id} meta={meta[id]} />
        ))}
      </section>

      <section className="mt-6 grid grid-cols-2 gap-3">
        <Link href="/activity" className="btn card p-4">
          <div className="text-[15px] font-semibold">Activity</div>
          <div className="text-[13px] text-[var(--muted)]">What the agents have done</div>
        </Link>
        <Link href="/family" className="btn card p-4">
          <div className="text-[15px] font-semibold">Family</div>
          <div className="text-[13px] text-[var(--muted)]">Caregiver dashboard</div>
        </Link>
      </section>

      <p className="mt-6 text-center text-[12px] text-[var(--muted)]">
        Backend: {backend === "convex" ? "Convex (live)" : "in-process (sandbox)"} · Each agent runs independently.
      </p>
    </main>
  );
}
