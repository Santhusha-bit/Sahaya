"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Check } from "lucide-react";
import { Reveal } from "./Reveal";

export type CapabilityBlock = {
  label: string;
  title: string;
  features: string[];
};

/**
 * Shared split-screen layout for the four feature sections.
 * `reverse` flips the visual to the opposite side for rhythm.
 */
export function FeatureLayout({
  id,
  index,
  name,
  icon: Icon,
  color,
  tint,
  headline,
  description,
  visual,
  blocks,
  reverse = false,
  note,
  children,
}: {
  id: string;
  index: string;
  name: string;
  icon: LucideIcon;
  color: string;
  tint: string;
  headline: ReactNode;
  description: string;
  visual: ReactNode;
  blocks: CapabilityBlock[];
  reverse?: boolean;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <section id={id} className="section scroll-mt-20" style={{ background: reverse ? "var(--color-bg-tint)" : undefined }}>
      <div className="container-xl">
        <div
          className={`grid items-center gap-12 lg:grid-cols-2 lg:gap-16 ${
            reverse ? "lg:[&>*:first-child]:order-2" : ""
          }`}
        >
          {/* Copy side */}
          <div>
            <Reveal>
              <span
                className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider"
                style={{ background: tint, color }}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {index} / {name}
              </span>
            </Reveal>
            <Reveal delay={0.05}>
              <h2 className="h2 mt-5">{headline}</h2>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="lead mt-4">{description}</p>
            </Reveal>
          </div>

          {/* Visual side */}
          <Reveal delay={0.1} className="flex justify-center">
            {visual}
          </Reveal>
        </div>

        {/* Capability blocks */}
        <div className="mt-16 grid gap-5 md:grid-cols-3">
          {blocks.map((block, i) => (
            <Reveal key={block.title} delay={i * 0.08}>
              <article className="card card-lift h-full p-6">
                <span
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color }}
                >
                  {block.label}
                </span>
                <h3 className="mt-2 text-lg font-bold leading-snug text-ink">
                  {block.title}
                </h3>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {block.features.map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[0.92rem] text-muted">
                      <span
                        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                        style={{ background: `${color}1a`, color }}
                      >
                        <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
              </article>
            </Reveal>
          ))}
        </div>

        {children}

        {note && (
          <Reveal>
            <p className="mx-auto mt-10 max-w-3xl rounded-2xl border border-line bg-white/60 px-5 py-4 text-center text-sm text-muted">
              {note}
            </p>
          </Reveal>
        )}
      </div>
    </section>
  );
}
