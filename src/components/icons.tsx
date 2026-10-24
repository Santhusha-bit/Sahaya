import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const base = (props: IconProps) => ({
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export function ShieldIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}
export function HeartPulseIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M20.8 6.6a5 5 0 0 0-8.8-1.3A5 5 0 0 0 3.2 8.4c0 4.4 6 8 8.8 10 .8-.6 2-1.4 3.2-2.4" />
      <path d="M8 12h2l1.5 3 2-6 1.5 3H21" />
    </svg>
  );
}
export function SparklesIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z" />
      <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14Z" />
    </svg>
  );
}
export function ReceiptIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 3h12v18l-2-1.2L14 21l-2-1.2L10 21l-2-1.2L6 21V3Z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}
export function HomeIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}
export function GridIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
export function ActivityIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M3 12h4l2 6 4-14 2 8h6" />
    </svg>
  );
}
export function UsersIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c0-3 2.7-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 15c2.5 0 4.5 2 4.5 5" />
      <circle cx="17" cy="8" r="2.6" />
    </svg>
  );
}
export function UserIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" />
    </svg>
  );
}
export function MicIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0" />
      <path d="M12 17v4M9 21h6" />
    </svg>
  );
}
export function SendIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 12l16-8-6 16-3-6-7-2Z" />
    </svg>
  );
}
export function CheckIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 12l5 5L20 6" />
    </svg>
  );
}
export function XIcon(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export const AGENT_ICONS: Record<string, (p: IconProps) => React.JSX.Element> = {
  shield: ShieldIcon,
  "heart-pulse": HeartPulseIcon,
  sparkles: SparklesIcon,
  receipt: ReceiptIcon,
};
