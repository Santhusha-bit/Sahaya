"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ActivityIcon, GridIcon, HomeIcon, UserIcon, UsersIcon } from "./icons";

const TABS = [
  { href: "/", label: "Home", Icon: HomeIcon, match: (p: string) => p === "/" },
  { href: "/agents", label: "Agents", Icon: GridIcon, match: (p: string) => p.startsWith("/agents") },
  { href: "/activity", label: "Activity", Icon: ActivityIcon, match: (p: string) => p.startsWith("/activity") },
  { href: "/family", label: "Family", Icon: UsersIcon, match: (p: string) => p.startsWith("/family") },
  { href: "/profile", label: "Profile", Icon: UserIcon, match: (p: string) => p.startsWith("/profile") },
];

export function BottomNav() {
  const pathname = usePathname() || "/";
  return (
    <div
      className="fixed bottom-0 left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 px-4 pt-2"
      style={{ paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}
    >
      <nav
        className="rounded-[22px] border border-white/60 bg-white/80 shadow-[0_8px_30px_rgba(20,24,41,0.14)] backdrop-blur-xl"
      >
        <ul className="grid grid-cols-5">
          {TABS.map(({ href, label, Icon, match }) => {
            const active = match(pathname);
            return (
              <li key={href}>
                <Link
                  href={href}
                  className="relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors"
                  style={{ color: active ? "var(--brand)" : "#9aa0b4" }}
                >
                  <span
                    className="flex h-8 w-11 items-center justify-center rounded-full transition-all duration-200"
                    style={active ? { background: "var(--brand-soft)" } : undefined}
                  >
                    <Icon width={22} height={22} strokeWidth={active ? 2.4 : 2} />
                  </span>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
