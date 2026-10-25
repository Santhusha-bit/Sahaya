import { Logo } from "@/components/brand/Logo";
import { DEMO_URL } from "@/lib/constants";

const columns = [
  {
    title: "Explore",
    links: [
      { label: "Home", href: "#home" },
      { label: "Features", href: "#features" },
      { label: "How It Works", href: "#how-it-works" },
      { label: "Technology", href: "#technology" },
      { label: "Team", href: "#team" },
    ],
  },
  {
    title: "Product",
    links: [
      { label: "Guardian", href: "#features" },
      { label: "Care", href: "#care" },
      { label: "Wellness", href: "#wellness" },
      { label: "Finance", href: "#finance" },
      { label: "Live Demo", href: DEMO_URL },
    ],
  },
  {
    title: "Information",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Contact", href: "/contact" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-bg">
      <div className="container-xl py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo size={34} />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              Independence for them. Peace of mind for you.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-bold uppercase tracking-wider text-ink">
                {col.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-muted transition-colors hover:text-brand-ink"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-3 border-t border-line pt-6 sm:flex-row">
          <p className="text-sm text-muted">
            © 2026 Sahaya. All rights reserved.
          </p>
          <p className="text-sm font-medium text-brand-ink">Built with care.</p>
        </div>
      </div>
    </footer>
  );
}
