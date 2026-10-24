import Link from "next/link";
import type { AgentMeta } from "@/agents/registry";
import { AGENT_ICONS, ChevronRightIcon } from "./icons";

export function AgentCard({ meta, compact = false }: { meta: AgentMeta; compact?: boolean }) {
  const Icon = AGENT_ICONS[meta.theme.icon] ?? AGENT_ICONS.shield;
  return (
    <Link
      href={`/agents/${meta.id}`}
      className="group card card-interactive fade-up relative flex items-center gap-4 overflow-hidden p-4"
    >
      {/* Accent wash that intensifies on hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{ background: `linear-gradient(90deg, ${meta.theme.accentSoft}55, transparent 55%)` }}
      />
      <div
        className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white shadow-md transition-transform duration-200 group-hover:scale-[1.04]"
        style={{ background: meta.theme.gradient, boxShadow: `0 8px 20px ${meta.theme.accent}44` }}
      >
        <Icon width={28} height={28} />
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="text-[17px] font-bold tracking-tight" style={{ color: meta.theme.accent }}>
          {meta.displayName}
        </div>
        {!compact && <div className="text-[14px] leading-snug text-[var(--muted)]">{meta.tagline}</div>}
      </div>
      <div
        className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--faint)] transition-all duration-200 group-hover:translate-x-0.5"
        style={{ background: "var(--bg-tint)" }}
        aria-hidden
      >
        <ChevronRightIcon width={18} height={18} />
      </div>
    </Link>
  );
}
