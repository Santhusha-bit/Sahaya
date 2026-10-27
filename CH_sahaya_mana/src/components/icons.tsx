import type { AgentId } from "@/agents/base/types";

type IconProps = { className?: string };

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
};

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

export function PillIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" />
      <path d="M9.5 9.5l5 5" />
    </svg>
  );
}

export function HeartIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}

export function WalletIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14.5h2" />
    </svg>
  );
}

export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 11l8-7 8 7v9a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1v-9z" />
    </svg>
  );
}

export function GridIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ActivityIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </svg>
  );
}

export function FamilyIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="8" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M2.5 20a5.5 5.5 0 0111 0M13.5 20a4 4 0 018 0" />
    </svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0116 0" />
    </svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 12l16-8-6 16-2-7-8-1z" />
    </svg>
  );
}

export function BackIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function AgentIcon({ agent, className }: IconProps & { agent: AgentId }) {
  switch (agent) {
    case "guardian":
      return <ShieldIcon className={className} />;
    case "care":
      return <PillIcon className={className} />;
    case "wellness":
      return <HeartIcon className={className} />;
    case "finance":
      return <WalletIcon className={className} />;
  }
}
