"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { PhoneFrame } from "@/components/ui/PhoneFrame";
import { IllustrativeBadge } from "@/components/ui/IllustrativeBadge";
import { CAPABILITIES, CAPABILITY_ORDER, type CapabilityKey } from "@/data/capabilities";
import { DEMO_URL } from "@/lib/constants";

type Demo = {
  messages: { from: "user" | "ai"; text: string }[];
  status: { title: string; sub: string };
};

const demos: Record<CapabilityKey, Demo> = {
  guardian: {
    messages: [
      { from: "ai", text: "A caller is asking you to send gift cards urgently." },
      { from: "user", text: "They said my account will be closed." },
      { from: "ai", text: "That's a common scam tactic. Let's pause and verify before doing anything." },
    ],
    status: { title: "Verification requested", sub: "No funds or action taken" },
  },
  care: {
    messages: [
      { from: "ai", text: "It's time for your evening medication, Margaret." },
      { from: "user", text: "Thank you, I'll take it now. I'm running low though." },
      { from: "ai", text: "Noted. I'll prepare a refill request for your approval." },
    ],
    status: { title: "Refill drafted", sub: "Awaiting your approval" },
  },
  wellness: {
    messages: [
      { from: "user", text: "I've been feeling a bit low this week." },
      { from: "ai", text: "I'm glad you told me. Would you like to talk, or arrange a call with family?" },
    ],
    status: { title: "Observation noted", sub: "Follow-up offered, not diagnosed" },
  },
  finance: {
    messages: [
      { from: "ai", text: "I spotted a possible duplicate charge of $85 on this bill." },
      { from: "user", text: "I don't remember paying that twice." },
      { from: "ai", text: "I can prepare a review request. Nothing is sent without your approval." },
    ],
    status: { title: "Review prepared", sub: "Approval required before sending" },
  },
};

export function InteractiveShowcase() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState<CapabilityKey>("guardian");
  const cap = CAPABILITIES[active];
  const demo = demos[active];
  const Icon = cap.icon;

  return (
    <section className="section relative overflow-hidden">
      <div className="container-xl">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">See Sahaya in action</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              Real conversations. <span className="text-gradient">Meaningful assistance.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              Explore how one companion adapts across every part of life. These are
              illustrative product scenarios, not the live demo.
            </p>
          </Reveal>
        </div>

        {/* Tabs */}
        <Reveal delay={0.1}>
          <div
            className="mx-auto mt-10 flex max-w-xl flex-wrap justify-center gap-2 rounded-full border border-line bg-white p-1.5 shadow-sm"
            role="tablist"
            aria-label="Capability demos"
          >
            {CAPABILITY_ORDER.map((key) => {
              const c = CAPABILITIES[key];
              const isActive = key === active;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={isActive}
                  type="button"
                  onClick={() => setActive(key)}
                  className="flex items-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-semibold transition-all"
                  style={
                    isActive
                      ? { background: c.color, color: "#fff" }
                      : { color: "var(--color-muted)" }
                  }
                >
                  <c.icon className="h-4 w-4" aria-hidden="true" />
                  {c.name}
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Demo stage */}
        <Reveal delay={0.1}>
          <div className="mt-12 flex flex-col items-center gap-8 lg:flex-row lg:justify-center lg:gap-16">
            <div className="relative">
              <span className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
                <IllustrativeBadge />
              </span>
              <PhoneFrame>
                <div className="flex min-h-[560px] flex-col px-4 pb-5 pt-12">
                  <div className="flex items-center gap-2.5 border-b border-line pb-3">
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-xl"
                      style={{ background: `${cap.color}1a`, color: cap.color }}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-ink">{cap.name}</p>
                      <p className="text-[0.68rem] text-muted">{cap.tagline}</p>
                    </div>
                  </div>

                  <AnimatePresence mode="wait">
                    <motion.div
                      key={active}
                      className="flex flex-1 flex-col gap-2.5 py-4"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -16 }}
                      transition={{ duration: 0.35 }}
                    >
                      {demo.messages.map((m, i) => (
                        <motion.div
                          key={i}
                          className={`bubble ${m.from === "user" ? "bubble-user" : "bubble-ai"}`}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, delay: 0.1 + i * 0.2 }}
                        >
                          {m.text}
                        </motion.div>
                      ))}
                      <div
                        className="mt-auto rounded-2xl border px-3 py-2.5 text-xs"
                        style={{ borderColor: `${cap.color}40`, background: cap.tint }}
                      >
                        <p className="font-bold text-ink">{demo.status.title}</p>
                        <p className="text-muted">{demo.status.sub}</p>
                      </div>
                    </motion.div>
                  </AnimatePresence>
                </div>
              </PhoneFrame>
            </div>

            <div className="max-w-sm text-center lg:text-left">
              <h3 className="h3" style={{ color: cap.color }}>
                {cap.name}
              </h3>
              <p className="mt-2 text-muted">{cap.tagline}.</p>
              <p className="mt-4 text-[0.95rem] text-muted">
                Every scenario runs through the same unified companion, which decides
                which capability to use and always asks before taking sensitive
                action.
              </p>
              <a href={DEMO_URL} className="btn btn-primary mt-7">
                Launch the Live Sahaya Demo
                <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
