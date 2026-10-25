"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import {
  STATUS_LABEL,
  type Technology,
} from "@/data/technologies";

type Anchor = { x: number; y: number; width: number; height: number };

/**
 * Collision-aware floating info cloud anchored near a technology logo.
 * Rendered as a fixed-position element so it never clips inside the section.
 * Stays open while the pointer is over the logo OR the cloud.
 */
export function HoverCloud({
  tech,
  anchor,
  onEnter,
  onLeave,
  onClose,
}: {
  tech: Technology;
  anchor: Anchor;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "top" | "bottom" }>(
    { top: 0, left: 0, placement: "bottom" }
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cw = el.offsetWidth;
    const ch = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 12;
    const margin = 12;

    // Prefer below the anchor; flip above if not enough room.
    let placement: "top" | "bottom" = "bottom";
    let top = anchor.y + anchor.height + gap;
    if (top + ch > vh - margin && anchor.y - gap - ch > margin) {
      placement = "top";
      top = anchor.y - gap - ch;
    }

    // Center horizontally on the anchor, then clamp into the viewport.
    let left = anchor.x + anchor.width / 2 - cw / 2;
    left = Math.max(margin, Math.min(left, vw - cw - margin));

    setPos({ top, left, placement });
  }, [anchor, tech.id]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const statusTone =
    tech.status === "used"
      ? "bg-soft text-brand-ink"
      : tech.status === "planned"
      ? "bg-[#fbf0dc] text-[#9a6a1e]"
      : "bg-bg-tint text-muted";

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={`${tech.name} details`}
      className="panel fixed z-[90] w-[300px] max-w-[calc(100vw-24px)] rounded-[28px] p-5 shadow-[0_20px_50px_rgba(23,43,58,0.2)]"
      style={{
        top: pos.top,
        left: pos.left,
        boxShadow:
          "0 20px 50px rgba(23,43,58,0.2), 0 0 0 1px rgba(22,139,130,0.12), 0 0 40px rgba(22,139,130,0.14)",
      }}
      initial={{ opacity: 0, scale: 0.92, y: pos.placement === "bottom" ? -8 : 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {/* Decorative sparkle dots */}
      <span className="pointer-events-none absolute -right-1 -top-1 h-2 w-2 rounded-full bg-brand/40" />
      <span className="pointer-events-none absolute right-5 -top-2 h-1.5 w-1.5 rounded-full bg-gold/60" />

      <div className="flex items-start gap-3">
        <span className="flex h-11 w-20 shrink-0 items-center justify-center rounded-xl border border-line bg-white px-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tech.logo}
            alt={`${tech.name} logo`}
            className="h-5 w-auto object-contain"
          />
        </span>
        <div className="min-w-0">
          <p className="text-base font-extrabold leading-tight text-ink">
            {tech.name}
          </p>
          <p className="text-xs font-medium text-muted">{tech.tagline}</p>
        </div>
      </div>

      <span
        className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-[0.68rem] font-bold uppercase tracking-wide ${statusTone}`}
      >
        {STATUS_LABEL[tech.status]}
      </span>

      <p className="mt-3 text-[0.86rem] leading-relaxed text-muted">{tech.role}</p>

      <p className="mt-2.5 text-[0.8rem] leading-relaxed text-faint">
        <span className="font-semibold text-ink">Why it matters: </span>
        {tech.why}
      </p>

      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {tech.capabilities.map((c) => (
          <span
            key={c}
            className="rounded-full border border-line bg-white px-2 py-0.5 text-[0.68rem] font-semibold text-brand-ink"
          >
            {c}
          </span>
        ))}
      </div>

      <a
        href={tech.website}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-brand-ink hover:underline"
      >
        Visit {tech.name}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </motion.div>
  );
}
