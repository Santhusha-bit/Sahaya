"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Logo } from "@/components/brand/Logo";
import { Reveal } from "@/components/ui/Reveal";
import { CAPABILITIES, CAPABILITY_ORDER } from "@/data/capabilities";

const descriptions: Record<string, string> = {
  guardian:
    "Recognizes suspicious interactions, responds to emergencies, and connects trusted people when help is needed.",
  care:
    "Simplifies medications, groceries, and meals, the routines that make independent living possible.",
  wellness:
    "Notices meaningful changes in self-reported sleep, mood, and energy, and offers warm follow-ups.",
  finance:
    "Reviews bills, flags possible issues, and keeps sensitive financial actions under the user's control.",
};

// Node positions around the center (percentages).
const positions = [
  { top: "6%", left: "50%" },
  { top: "50%", left: "94%" },
  { top: "94%", left: "50%" },
  { top: "50%", left: "6%" },
];

export function Solution() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<string | null>(null);

  return (
    <section className="section relative overflow-hidden">
      <div
        className="ambient h-[400px] w-[400px] bg-[#cdeae4]"
        style={{ top: "20%", left: "60%", opacity: 0.4 }}
      />
      <div className="container-xl relative">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">The Sahaya Difference</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              One companion. <span className="text-gradient">Four ways to care.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              Sahaya brings personal safety, everyday assistance, wellness
              awareness, and financial support together through one natural,
              voice-first experience.
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.1}>
          <div className="relative mx-auto mt-16 aspect-square w-full max-w-[520px]">
            {/* Connection lines */}
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {positions.map((pos, i) => {
                const cx = parseFloat(pos.left);
                const cy = parseFloat(pos.top);
                const isActive =
                  active === null || active === CAPABILITY_ORDER[i];
                return (
                  <line
                    key={i}
                    x1="50"
                    y1="50"
                    x2={cx}
                    y2={cy}
                    stroke={CAPABILITIES[CAPABILITY_ORDER[i]].color}
                    strokeWidth={isActive ? 0.6 : 0.3}
                    strokeOpacity={isActive ? 0.5 : 0.2}
                    strokeDasharray="2 2"
                    className="transition-all duration-300"
                  >
                    {!reduce && (
                      <animate
                        attributeName="stroke-dashoffset"
                        from="8"
                        to="0"
                        dur="1.2s"
                        repeatCount="indefinite"
                      />
                    )}
                  </line>
                );
              })}
            </svg>

            {/* Center node */}
            <motion.div
              className="absolute left-1/2 top-1/2 z-10 flex h-28 w-28 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-line bg-white text-center shadow-lg sm:h-32 sm:w-32"
              animate={reduce ? {} : { scale: [1, 1.03, 1] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            >
              <Logo size={30} withWordmark={false} />
              <span className="mt-1.5 text-sm font-extrabold text-ink">Sahaya AI</span>
              <span className="text-[0.65rem] font-medium text-muted">
                One unified agent
              </span>
            </motion.div>

            {/* Capability nodes */}
            {CAPABILITY_ORDER.map((key, i) => {
              const cap = CAPABILITIES[key];
              const pos = positions[i];
              const Icon = cap.icon;
              const dim = active !== null && active !== key;
              return (
                <button
                  key={key}
                  type="button"
                  className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 transition-all duration-300 focus:outline-none"
                  style={{
                    top: pos.top,
                    left: pos.left,
                    opacity: dim ? 0.45 : 1,
                  }}
                  onMouseEnter={() => setActive(key)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(key)}
                  onBlur={() => setActive(null)}
                  aria-describedby={`cap-desc-${key}`}
                >
                  <span
                    className="flex h-16 w-16 items-center justify-center rounded-2xl border bg-white shadow-md transition-transform duration-300 hover:scale-110 sm:h-18 sm:w-18"
                    style={{
                      borderColor: `${cap.color}40`,
                      color: cap.color,
                      boxShadow:
                        active === key ? `0 10px 30px ${cap.color}40` : undefined,
                    }}
                  >
                    <Icon className="h-7 w-7" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-bold text-ink">{cap.name}</span>
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Active description */}
        <div className="mx-auto mt-6 min-h-[3.5rem] max-w-xl text-center">
          {CAPABILITY_ORDER.map((key) => (
            <p
              key={key}
              id={`cap-desc-${key}`}
              className={`text-[0.98rem] font-medium text-muted transition-opacity duration-300 ${
                active === key ? "opacity-100" : "sr-only"
              }`}
            >
              <span
                className="font-bold"
                style={{ color: CAPABILITIES[key].color }}
              >
                {CAPABILITIES[key].name}:
              </span>{" "}
              {descriptions[key]}
            </p>
          ))}
          {active === null && (
            <p className="text-[0.98rem] font-medium text-faint">
              Hover or focus a capability to see how it connects to Sahaya.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
