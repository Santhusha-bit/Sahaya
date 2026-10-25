"use client";

import { useEffect, useState } from "react";
import { Menu, X, ArrowUpRight } from "lucide-react";
import { Logo } from "./brand/Logo";
import { NAV_LINKS, DEMO_URL } from "@/lib/constants";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Lock body scroll when the mobile menu is open.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? "panel shadow-[0_4px_20px_rgba(23,43,58,0.06)]" : "bg-transparent"
      }`}
    >
      <nav
        className="container-xl flex h-[72px] items-center justify-between"
        aria-label="Primary"
      >
        <a href="#home" className="shrink-0" aria-label="Sahaya home">
          <Logo size={34} />
        </a>

        <ul className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="rounded-full px-3.5 py-2 text-[0.95rem] font-medium text-muted transition-colors hover:bg-soft hover:text-brand-ink"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <a
            href={DEMO_URL}
            className="btn btn-primary hidden h-11 px-5 py-0 text-[0.95rem] sm:inline-flex"
          >
            Try Live Demo
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <button
            type="button"
            className="btn btn-secondary h-11 w-11 p-0 lg:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {open && (
        <div className="panel border-t border-line lg:hidden">
          <ul className="container-xl flex flex-col gap-1 py-4">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-4 py-3 text-lg font-medium text-ink transition-colors hover:bg-soft hover:text-brand-ink"
                >
                  {link.label}
                </a>
              </li>
            ))}
            <li className="mt-2">
              <a
                href={DEMO_URL}
                className="btn btn-primary w-full"
                onClick={() => setOpen(false)}
              >
                Try Live Demo
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}
