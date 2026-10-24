import Link from "next/link";
import { AgentCard } from "@/components/AgentCard";
import { agentMeta, AGENT_IDS } from "@/agents/registry";
import { getCurrentUser } from "@/lib/user";
import { getDataLayer } from "@/agents/base/dataLayer";
import { ActivityIcon, ChevronRightIcon, ShieldCheckIcon, UsersIcon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const meta = agentMeta();
  const user = getCurrentUser();
  const backend = getDataLayer().backend;
  const firstName = user.name.split(" ")[0];

  return (
    <main className="px-5 pt-7">
      {/* Brand bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl text-white"
            style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-brand)" }}
          >
            <ShieldCheckIcon width={19} height={19} />
          </div>
          <span className="text-[19px] font-extrabold tracking-tight">Kinline</span>
        </div>
        <Link
          href="/profile"
          className="btn flex h-10 w-10 items-center justify-center rounded-full bg-white text-[15px] font-bold text-[var(--brand)] shadow-sm"
          style={{ border: "1px solid var(--line)" }}
          aria-label="Profile"
        >
          {firstName.charAt(0)}
        </Link>
      </div>

      {/* Hero */}
      <header
        className="fade-up relative mt-6 overflow-hidden rounded-[26px] p-6 text-white"
        style={{ background: "var(--brand-grad)", boxShadow: "var(--shadow-lg)" }}
      >
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-white/15 blur-2xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-8 h-44 w-44 rounded-full bg-black/10 blur-2xl" />
        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold backdrop-blur">
            <span className="live-dot" /> All systems watching over you
          </div>
          <h1 className="mt-4 text-[30px] font-extrabold leading-tight tracking-tight">Hello, {firstName}.</h1>
          <p className="mt-1.5 max-w-[32ch] text-[15px] leading-relaxed text-white/85">
            Four caring helpers, each here for a different part of your day. Tap one to talk.
          </p>
        </div>
      </header>

      {/* Agents */}
      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="eyebrow">Your companions</h2>
          <Link href="/agents" className="text-[13px] font-semibold text-[var(--brand)]">
            See all
          </Link>
        </div>
        <div className="flex flex-col gap-3">
          {AGENT_IDS.map((id, i) => (
            <div key={id} className={`stagger-${Math.min(i + 1, 4)}`}>
              <AgentCard meta={meta[id]} />
            </div>
          ))}
        </div>
      </section>

      {/* Quick actions */}
      <section className="mt-7">
        <h2 className="eyebrow mb-3">Overview</h2>
        <div className="grid grid-cols-2 gap-3">
          <Link href="/activity" className="card card-interactive fade-up flex flex-col gap-3 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--brand-soft)] text-[var(--brand)]">
              <ActivityIcon width={22} height={22} />
            </div>
            <div>
              <div className="flex items-center gap-1 text-[15px] font-bold tracking-tight">
                Activity <ChevronRightIcon width={15} height={15} className="text-[var(--faint)]" />
              </div>
              <div className="text-[13px] leading-snug text-[var(--muted)]">What the agents have done</div>
            </div>
          </Link>
          <Link href="/family" className="card card-interactive fade-up flex flex-col gap-3 p-4">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <UsersIcon width={22} height={22} />
            </div>
            <div>
              <div className="flex items-center gap-1 text-[15px] font-bold tracking-tight">
                Family <ChevronRightIcon width={15} height={15} className="text-[var(--faint)]" />
              </div>
              <div className="text-[13px] leading-snug text-[var(--muted)]">Caregiver dashboard</div>
            </div>
          </Link>
        </div>
      </section>

      <div className="mt-7 flex items-center justify-center gap-2 text-[12px] text-[var(--faint)]">
        <span className="live-dot" style={{ background: backend === "convex" ? "#22c55e" : "#f59e0b" }} />
        {backend === "convex" ? "Convex · live backend" : "Sandbox · in-process"} · agents run independently
      </div>
    </main>
  );
}
