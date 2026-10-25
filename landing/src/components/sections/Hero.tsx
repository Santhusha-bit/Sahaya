"use client";

import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowUpRight,
  Mic,
  Shield,
  Heart,
  Sparkles,
  Receipt,
  ShieldAlert,
  Pill,
  HeartHandshake,
  Users,
} from "lucide-react";
import { DEMO_URL } from "@/lib/constants";

const trust = [
  "Voice-first simplicity",
  "Personalized everyday support",
  "Family-connected care",
];

const shortcuts = [
  { label: "Guardian", icon: Shield, color: "#168B82" },
  { label: "Care", icon: Heart, color: "#4779B8" },
  { label: "Wellness", icon: Sparkles, color: "#C98A2E" },
  { label: "Finance", icon: Receipt, color: "#5A6ACF" },
];

const floatingCards = [
  {
    icon: ShieldAlert,
    title: "Suspicious request detected",
    sub: "Verification recommended",
    color: "#168B82",
    pos: "left-[-8%] top-[14%]",
    delay: 0,
  },
  {
    icon: Pill,
    title: "Morning medication reminder",
    sub: "Confirmation pending",
    color: "#4779B8",
    pos: "right-[-10%] top-[6%]",
    delay: 0.6,
  },
  {
    icon: HeartHandshake,
    title: "Daily check-in",
    sub: "Ready when you are",
    color: "#C98A2E",
    pos: "left-[-12%] bottom-[20%]",
    delay: 1.2,
  },
  {
    icon: Users,
    title: "Family connected",
    sub: "Trusted contacts available",
    color: "#5A6ACF",
    pos: "right-[-8%] bottom-[10%]",
    delay: 1.8,
  },
];

export function Hero() {
  const reduce = useReducedMotion();

  const container = {
    hidden: {},
    show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
  };
  const item = {
    hidden: reduce ? { opacity: 0 } : { opacity: 0, y: 20 },
    show: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] as const },
    },
  };

  return (
    <section id="home" className="relative overflow-hidden pt-32 pb-20 lg:pt-40">
      {/* Ambient background */}
      <div
        className="ambient h-[480px] w-[480px] bg-[#9fe3d8]"
        style={{ top: "-120px", right: "-80px" }}
      />
      <div
        className="ambient h-[420px] w-[420px] bg-[#bcd3ef]"
        style={{ top: "160px", left: "-140px", opacity: 0.4 }}
      />

      <div className="container-xl relative grid items-center gap-16 lg:grid-cols-[1.05fr_0.95fr]">
        {/* Left: copy */}
        <motion.div variants={container} initial="hidden" animate="show">
          <motion.span
            variants={item}
            className="eyebrow mb-5 inline-flex rounded-full border border-line bg-white/70 px-3.5 py-1.5"
          >
            Meet Sahaya — Your AI companion for life
          </motion.span>

          <motion.h1 variants={item} className="h1 max-w-[16ch]">
            Growing older should never mean{" "}
            <span className="text-gradient">facing life alone.</span>
          </motion.h1>

          <motion.p variants={item} className="lead mt-6 max-w-[52ch]">
            Meet Sahaya, your intelligent AI companion for safer, healthier, and
            more independent living. From protecting against scams to managing
            everyday needs, Sahaya is always ready to help, and keeps your loved
            ones connected.
          </motion.p>

          <motion.div variants={item} className="mt-8 flex flex-wrap gap-3">
            <a href={DEMO_URL} className="btn btn-primary">
              Experience Sahaya
              <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
            </a>
            <a href="#features" className="btn btn-secondary">
              Explore Features
            </a>
          </motion.div>

          <motion.ul
            variants={item}
            className="mt-8 flex flex-wrap gap-x-6 gap-y-2"
          >
            {trust.map((t) => (
              <li
                key={t}
                className="flex items-center gap-2 text-sm font-medium text-muted"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-soft text-brand">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M20 6 9 17l-5-5"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {t}
              </li>
            ))}
          </motion.ul>
        </motion.div>

        {/* Right: phone composition */}
        <motion.div
          className="relative mx-auto flex max-w-[460px] items-center justify-center"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
        >
          <HeroPhone reduce={!!reduce} />

          {/* Floating cards */}
          {floatingCards.map((card) => (
            <motion.div
              key={card.title}
              className={`glass absolute z-20 hidden w-[200px] rounded-2xl p-3 shadow-[0_12px_30px_rgba(23,43,58,0.12)] md:block ${card.pos}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
              animate={
                reduce
                  ? { opacity: 1 }
                  : { opacity: 1, y: [0, -10, 0] }
              }
              transition={
                reduce
                  ? { duration: 0.4 }
                  : {
                      opacity: { duration: 0.5, delay: 0.8 + card.delay * 0.15 },
                      y: {
                        duration: 4.5,
                        delay: card.delay,
                        repeat: Infinity,
                        ease: "easeInOut",
                      },
                    }
              }
            >
              <div className="flex items-start gap-2.5">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: `${card.color}1a`, color: card.color }}
                >
                  <card.icon className="h-4.5 w-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.82rem] font-semibold leading-tight text-ink">
                    {card.title}
                  </p>
                  <p className="text-[0.72rem] text-muted">{card.sub}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function HeroPhone({ reduce }: { reduce: boolean }) {
  return (
    <div className="phone relative z-10 w-[290px]">
      <div className="absolute left-1/2 top-[18px] z-20 h-[22px] w-[90px] -translate-x-1/2 rounded-full bg-[#0d1b24]" />
      <div
        className="phone-screen flex flex-col px-5 pb-6 pt-14"
        style={{
          background:
            "radial-gradient(120% 60% at 80% -10%, rgba(22,139,130,0.1), transparent 60%), radial-gradient(90% 50% at -10% 0%, rgba(71,121,184,0.1), transparent 55%), #fafaf7",
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-ink">
          Sahaya
        </p>
        <h2 className="mt-3 text-2xl font-extrabold leading-tight text-ink">
          Good morning, Margaret.
        </h2>
        <p className="mt-1 text-[0.95rem] text-muted">
          How can I help you today?
        </p>

        {/* Mic */}
        <div className="my-7 flex flex-col items-center">
          <div className="relative flex h-28 w-28 items-center justify-center">
            {!reduce && (
              <>
                <span className="absolute inset-0 animate-ping rounded-full bg-brand/15 [animation-duration:2.5s]" />
                <span className="absolute inset-3 rounded-full bg-brand/10" />
              </>
            )}
            <button
              type="button"
              aria-label="Talk to Sahaya"
              className="relative flex h-20 w-20 items-center justify-center rounded-full text-white shadow-brand"
              style={{
                background: "linear-gradient(135deg,#19A396,#168B82)",
              }}
            >
              <Mic className="h-8 w-8" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-3 text-xs font-medium text-muted">Tap to speak</p>
        </div>

        {/* Shortcuts */}
        <div className="grid grid-cols-2 gap-2.5">
          {shortcuts.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2 rounded-2xl border border-line bg-white px-3 py-2.5 shadow-sm"
            >
              <span
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{ background: `${s.color}1a`, color: s.color }}
              >
                <s.icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-ink">{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
