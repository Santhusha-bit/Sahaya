"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ActivityIcon, FamilyIcon, GridIcon, HomeIcon, UserIcon } from "@/components/icons";

const ITEMS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/agents", label: "Agents", Icon: GridIcon },
  { href: "/activity", label: "Activity", Icon: ActivityIcon },
  { href: "/family", label: "Family", Icon: FamilyIcon },
  { href: "/profile", label: "Profile", Icon: UserIcon },
] as const;

export function BottomNav() {
  return <NavFrame pathname={usePathname()} />;
}

/** Hook-free frame; rendered with `pathname={null}` as the prerendered fallback. */
export function NavFrame({ pathname }: { pathname: string | null }) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-xl justify-between px-2">
        {ITEMS.map(({ href, label, Icon }) => {
          const active = pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href));
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl text-sm font-semibold ${
                  active ? "text-brand" : "text-ink-muted"
                }`}
              >
                <Icon className="h-7 w-7" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
