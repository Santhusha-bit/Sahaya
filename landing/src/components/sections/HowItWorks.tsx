"use client";

import { Mic, BrainCircuit, Sparkles } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const steps = [
  {
    icon: Mic,
    n: "01",
    title: "Speak naturally",
    body: "Older adults interact with Sahaya using ordinary language. No complicated menus or technical knowledge required.",
    quote: "“Sahaya, can you help me today?”",
  },
  {
    icon: BrainCircuit,
    n: "02",
    title: "Sahaya understands",
    body: "The unified AI companion interprets the request, uses relevant permitted context, and determines which capabilities are needed.",
    quote: "A medication request activates the Care workflow.",
  },
  {
    icon: Sparkles,
    n: "03",
    title: "Sahaya helps you act",
    body: "Sahaya provides guidance, prepares tasks, coordinates supported services, or requests approval before sensitive actions.",
    quote: "Authorized family members can receive relevant updates.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section relative overflow-hidden">
      <div className="container-xl">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">Simple by design</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              Just talk. <span className="text-gradient">Sahaya takes care of the next steps.</span>
            </h2>
          </Reveal>
        </div>

        <div className="relative mt-16">
          {/* Connecting line (desktop) */}
          <div
            className="absolute left-0 right-0 top-[44px] hidden h-0.5 md:block"
            style={{
              background:
                "linear-gradient(90deg, transparent, var(--color-brand) 20%, var(--color-blue) 80%, transparent)",
              opacity: 0.35,
            }}
            aria-hidden="true"
          />
          <ol className="grid gap-8 md:grid-cols-3 md:gap-6">
            {steps.map((s, i) => (
              <Reveal as="li" key={s.n} delay={i * 0.12} className="relative">
                <div className="flex flex-col items-center text-center md:items-start md:text-left">
                  <span className="relative z-10 flex h-[88px] w-[88px] items-center justify-center rounded-full border border-line bg-white shadow-md">
                    <s.icon className="h-8 w-8 text-brand" aria-hidden="true" />
                  </span>
                  <span className="mt-4 text-sm font-bold text-brand-ink">
                    Step {s.n}
                  </span>
                  <h3 className="mt-1.5 text-xl font-bold text-ink">{s.title}</h3>
                  <p className="mt-2 text-[0.95rem] leading-relaxed text-muted">
                    {s.body}
                  </p>
                  <p className="mt-3 rounded-xl bg-soft px-3.5 py-2 text-sm font-medium italic text-brand-ink">
                    {s.quote}
                  </p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
