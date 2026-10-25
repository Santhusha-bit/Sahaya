"use client";

import { useState } from "react";
import { GraduationCap, Linkedin } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

type Member = {
  name: string;
  school: string;
  program: string;
  initials: string;
  grad: string;
  /** Local photo under /public/team. Falls back to initials if missing. */
  photo: string;
  linkedin: string;
};

const team: Member[] = [
  {
    name: "Santhusha Mudannayaka",
    school: "UC Berkeley",
    program: "Electrical Engineering & Computer Sciences (EECS)",
    initials: "SM",
    grad: "from-[#19A396] to-[#4779B8]",
    photo: "/team/santhusha.png",
    linkedin: "https://www.linkedin.com/in/santhusha-mudannayaka/",
  },
  {
    name: "Pranav Virmalwar",
    school: "UC Berkeley",
    program: "MSc Analytics",
    initials: "PV",
    grad: "from-[#4779B8] to-[#5A6ACF]",
    photo: "/team/pranav.jpg",
    linkedin: "https://www.linkedin.com/in/pranav-virmalwar-351038195/",
  },
  {
    name: "Keshan De Silva",
    school: "San Francisco State University",
    program: "International Business",
    initials: "KD",
    grad: "from-[#C98A2E] to-[#19A396]",
    photo: "/team/keshan.jpg",
    linkedin: "https://www.linkedin.com/in/keshan-desilva/",
  },
];

function Avatar({ member }: { member: Member }) {
  const [failed, setFailed] = useState(false);

  // Catch images that already 404'd before React hydrated and attached onError
  // (the img starts loading during HTML parse, so the error event can be missed).
  const checkLoaded = (node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth === 0) setFailed(true);
  };

  if (failed) {
    return (
      <div
        className={`flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br ${member.grad} text-2xl font-extrabold text-white shadow-md transition-transform duration-300 group-hover:scale-105`}
        aria-hidden="true"
      >
        {member.initials}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={checkLoaded}
      src={member.photo}
      alt={`Portrait of ${member.name}`}
      className="h-full w-full rounded-full object-cover shadow-md transition-transform duration-300 group-hover:scale-105"
      onError={() => setFailed(true)}
    />
  );
}

export function Team() {
  return (
    <section id="team" className="section">
      <div className="container-xl">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">Meet the builders</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              Built by people who believe{" "}
              <span className="text-gradient">technology should care.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              We&apos;re a team of builders combining engineering, analytics, and
              business perspectives to make technology more accessible and meaningful
              for older adults and their families.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {team.map((m, i) => (
            <Reveal key={m.name} delay={i * 0.1}>
              <article className="card card-lift group h-full p-6 text-center">
                {/* Portrait (real photo with initials fallback) */}
                <div className="relative mx-auto h-28 w-28">
                  <Avatar member={m} />
                  <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-black/5" />
                </div>
                <h3 className="mt-5 text-lg font-bold text-ink">{m.name}</h3>
                <p className="mt-2 flex items-center justify-center gap-1.5 text-sm font-semibold text-brand-ink">
                  <GraduationCap className="h-4 w-4" aria-hidden="true" />
                  {m.school}
                </p>
                <p className="mt-1 text-sm text-muted">{m.program}</p>

                <div className="mt-5 flex justify-center">
                  <a
                    href={m.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${m.name} on LinkedIn`}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:border-brand hover:bg-soft hover:text-brand-ink"
                  >
                    <Linkedin className="h-4 w-4" aria-hidden="true" />
                  </a>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
