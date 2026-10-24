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
    <nav
      className="fixed bottom-0 left-1/2 z-40 w-full max-w-[480px] -translate-x-1/2 border-t border-[var(--line)] bg-white/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-5">
        {TABS.map(({ href, label, Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href}>
              <Link
                href={href}
                className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium"
                style={{ color: active ? "#2563eb" : "#8a93a6" }}
              >
                <Icon width={23} height={23} strokeWidth={active ? 2.4 : 2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
