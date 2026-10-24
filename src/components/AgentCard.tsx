import Link from "next/link";
import type { AgentMeta } from "@/agents/registry";
import { AGENT_ICONS } from "./icons";

export function AgentCard({ meta, compact = false }: { meta: AgentMeta; compact?: boolean }) {
  const Icon = AGENT_ICONS[meta.theme.icon] ?? AGENT_ICONS.shield;
  return (
    <Link
      href={`/agents/${meta.id}`}
      className="btn card fade-up flex items-center gap-4 p-4 active:opacity-90"
      style={{ borderColor: meta.theme.accentSoft }}
    >
      <div
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white"
        style={{ background: meta.theme.gradient }}
      >
        <Icon width={28} height={28} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[17px] font-bold" style={{ color: meta.theme.accent }}>
          {meta.displayName}
        </div>
        {!compact && <div className="text-[14px] leading-snug text-[var(--muted)]">{meta.tagline}</div>}
      </div>
      <div className="text-[var(--muted)]" aria-hidden>
        ›
      </div>
    </Link>
  );
}
