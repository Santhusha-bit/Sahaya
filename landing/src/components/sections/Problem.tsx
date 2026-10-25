"use client";

import { ShieldAlert, CalendarClock, HeartPulse, Users } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const problems = [
  {
    icon: ShieldAlert,
    title: "Digital scams & financial exploitation",
    body: "Older adults can face impersonation scams, phishing, and high-pressure financial requests designed to create panic.",
    color: "#168B82",
  },
  {
    icon: CalendarClock,
    title: "Fragmented daily assistance",
    body: "Medications, grocery shopping, household tasks, and appointments often require navigating multiple complicated systems.",
    color: "#4779B8",
  },
  {
    icon: HeartPulse,
    title: "Wellness changes go unnoticed",
    body: "Changes in reported sleep, appetite, mood, or energy can be difficult for distant family members to notice.",
    color: "#C98A2E",
  },
  {
    icon: Users,
    title: "Families cannot always be present",
    body: "Family members want to support loved ones without constantly monitoring them or reducing their independence.",
    color: "#5A6ACF",
  },
];

export function Problem() {
  return (
    <section id="why" className="section bg-bg-tint">
      <div className="container-xl">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">The Challenge</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">Aging shouldn&apos;t mean losing independence.</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              As everyday services become increasingly digital, many older adults
              face new challenges, from sophisticated scams and complicated
              financial systems to medication management, isolation, and
              coordinating daily assistance. Families want to help, but they
              cannot always be there.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {problems.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.08}>
              <article className="card card-lift h-full p-6">
                <span
                  className="flex h-12 w-12 items-center justify-center rounded-2xl"
                  style={{ background: `${p.color}18`, color: p.color }}
                >
                  <p.icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-lg font-bold leading-snug text-ink">
                  {p.title}
                </h3>
                <p className="mt-2.5 text-[0.95rem] leading-relaxed text-muted">
                  {p.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.2}>
          <p className="mx-auto mt-16 max-w-3xl text-center text-2xl font-bold leading-snug text-ink sm:text-3xl">
            What if one trusted companion could{" "}
            <span className="text-gradient">help with all of it?</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
