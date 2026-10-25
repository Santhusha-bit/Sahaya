import Link from "next/link";
import type { AgentId } from "@/agents/base/types";
import { AgentIcon } from "@/components/icons";
import { AGENT_THEME } from "./agentTheme";

export function AgentCard({
  id,
  name,
  tagline,
  detail,
}: {
  id: AgentId;
  name: string;
  tagline: string;
  detail?: React.ReactNode;
}) {
  const theme = AGENT_THEME[id];
  return (
    <Link
      href={`/agents/${id}`}
      className={`group flex items-center gap-4 rounded-[var(--radius-card)] border-2 border-transparent bg-surface p-5 shadow-sm transition ${theme.hoverBorder} active:scale-[0.99]`}
    >
      <span className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl ${theme.soft} ${theme.text}`}>
        <AgentIcon agent={id} className="h-9 w-9" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-2xl font-bold ${theme.text}`}>{name}</span>
        <span className="block text-lg leading-snug text-ink">{tagline}</span>
        {detail && <span className="mt-1 block text-base text-ink-muted">{detail}</span>}
      </span>
      <span aria-hidden className="text-3xl text-ink-muted transition group-hover:translate-x-0.5">
        ›
      </span>
    </Link>
  );
}
