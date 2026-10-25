"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Logo } from "@/components/brand/Logo";
import { Reveal } from "@/components/ui/Reveal";
import { HoverCloud } from "@/components/technology/HoverCloud";
import {
  TECHNOLOGIES,
  TECH_CATEGORIES,
  STATUS_LABEL,
  type Technology,
} from "@/data/technologies";

type Anchor = { x: number; y: number; width: number; height: number };

export function TechnologyShowcase() {
  const [filter, setFilter] = useState<(typeof TECH_CATEGORIES)[number]>("All");
  const [active, setActive] = useState<Technology | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Keep-open coordination between logo and cloud.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tilesRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const visible = TECHNOLOGIES.filter(
    (t) => filter === "All" || t.category === filter
  );

  const clearClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const open = useCallback(
    (tech: Technology, el: HTMLElement) => {
      clearClose();
      const r = el.getBoundingClientRect();
      setAnchor({ x: r.left, y: r.top, width: r.width, height: r.height });
      setActive(tech);
    },
    [clearClose]
  );

  const scheduleClose = useCallback(() => {
    clearClose();
    closeTimer.current = setTimeout(() => {
      setActive(null);
      setAnchor(null);
    }, 140);
  }, [clearClose]);

  const closeNow = useCallback(() => {
    clearClose();
    setActive(null);
    setAnchor(null);
  }, [clearClose]);

  // Click-away dismissal (covers tap-opened clouds) without blocking hover.
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      const insideCloud = (target as HTMLElement).closest?.("[role='dialog']");
      const insideTile = Array.from(tilesRef.current.values()).some((el) =>
        el.contains(target)
      );
      if (!insideCloud && !insideTile) closeNow();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [active, closeNow]);

  // Reposition the cloud on scroll/resize while open.
  useLayoutEffect(() => {
    if (!active) return;
    const reposition = () => {
      const el = tilesRef.current.get(active.id);
      if (el) {
        const r = el.getBoundingClientRect();
        setAnchor({ x: r.left, y: r.top, width: r.width, height: r.height });
      }
    };
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [active]);

  return (
    <section id="technology" className="section relative overflow-hidden bg-bg-tint">
      <div
        className="ambient h-[420px] w-[420px] bg-[#bfe6dd]"
        style={{ top: "10%", left: "55%", opacity: 0.35 }}
      />
      <div className="container-xl relative">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">Built with powerful technology</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              The technology behind{" "}
              <span className="text-gradient">every Sahaya moment.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              One intelligent companion, powered by specialized technologies working
              together to protect, support, and connect families. Hover, tap, or
              focus a logo to learn more.
            </p>
          </Reveal>
        </div>

        {/* Filter bar */}
        <Reveal delay={0.1}>
          <div
            className="mx-auto mt-10 flex max-w-full flex-wrap justify-center gap-2"
            role="group"
            aria-label="Filter technologies by category"
          >
            {TECH_CATEGORIES.map((cat) => {
              const isActive = cat === filter;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFilter(cat)}
                  aria-pressed={isActive}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold transition-all ${
                    isActive
                      ? "border-brand bg-brand text-white shadow-sm"
                      : "border-line bg-white text-muted hover:border-brand/40 hover:text-brand-ink"
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Central Sahaya node */}
        <Reveal delay={0.1}>
          <div className="mt-12 flex justify-center">
            <div className="flex items-center gap-3 rounded-full border border-line bg-white px-5 py-3 shadow-md">
              <Logo size={30} withWordmark={false} />
              <div className="text-left">
                <p className="text-sm font-extrabold text-ink">Sahaya AI</p>
                <p className="text-[0.7rem] text-muted">One companion, many technologies</p>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Logo grid / constellation */}
        <motion.ul
          layout
          className="mx-auto mt-8 grid max-w-5xl grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        >
          <AnimatePresence mode="popLayout">
            {visible.map((tech) => {
              const isActive = active?.id === tech.id;
              const dim = active !== null && !isActive;
              return (
                <motion.li
                  key={tech.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: dim ? 0.45 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.3 }}
                >
                  <button
                    ref={(el) => {
                      if (el) tilesRef.current.set(tech.id, el);
                      else tilesRef.current.delete(tech.id);
                    }}
                    type="button"
                    className="group relative flex h-24 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-white p-3 transition-all duration-300 hover:-translate-y-1 hover:shadow-md"
                    style={{
                      boxShadow: isActive ? "0 10px 30px rgba(22,139,130,0.25)" : undefined,
                      borderColor: isActive ? "rgba(22,139,130,0.4)" : undefined,
                    }}
                    aria-label={`${tech.name}: ${STATUS_LABEL[tech.status]}`}
                    aria-expanded={isActive}
                    onMouseEnter={(e) => open(tech, e.currentTarget)}
                    onMouseLeave={scheduleClose}
                    onFocus={(e) => open(tech, e.currentTarget)}
                    onBlur={scheduleClose}
                    onClick={(e) => {
                      if (isActive) closeNow();
                      else open(tech, e.currentTarget);
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={tech.logo}
                      alt={`${tech.name} logo`}
                      className="h-6 w-auto max-w-[80%] object-contain"
                    />
                    {tech.status !== "used" && (
                      <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-gold" title={STATUS_LABEL[tech.status]} />
                    )}
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </motion.ul>

        {/* Legend */}
        <Reveal>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-brand" /> Used in Sahaya
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-gold" /> Planned integration / dev tool
            </span>
          </div>
        </Reveal>

        {/* Closing statement */}
        <Reveal>
          <div className="mx-auto mt-16 max-w-2xl text-center">
            <p className="text-2xl font-bold text-ink sm:text-3xl">
              Different technologies. <span className="text-gradient">One seamless experience.</span>
            </p>
            <p className="mt-4 text-muted">
              Behind every conversation, reminder, and alert is a carefully connected
              system designed to make life simpler for older adults and their families.
            </p>
          </div>
        </Reveal>
      </div>

      {/* Floating cloud */}
      <AnimatePresence>
        {active && anchor && (
          <HoverCloud
            key={active.id}
            tech={active}
            anchor={anchor}
            onEnter={clearClose}
            onLeave={scheduleClose}
            onClose={closeNow}
          />
        )}
      </AnimatePresence>
    </section>
  );
}
