"use client";

import { Reveal } from "@/components/ui/Reveal";

export function Vision() {
  return (
    <section className="section relative overflow-hidden bg-bg-tint">
      <div
        className="ambient h-[360px] w-[360px] bg-[#f0d9ab]"
        style={{ bottom: "-10%", right: "5%", opacity: 0.4 }}
      />
      <div
        className="ambient h-[380px] w-[380px] bg-[#bfe6dd]"
        style={{ top: "-10%", left: "0%", opacity: 0.4 }}
      />
      <div className="container-xl relative">
        <div className="mx-auto max-w-3xl text-center">
          {/* Abstract intergenerational connection visual */}
          <Reveal>
            <svg
              viewBox="0 0 200 80"
              className="mx-auto mb-10 h-20 w-auto"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="vision-g" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="#168B82" />
                  <stop offset="1" stopColor="#4779B8" />
                </linearGradient>
              </defs>
              <path
                d="M40 40 C 80 10, 120 70, 160 40"
                fill="none"
                stroke="url(#vision-g)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray="3 4"
              />
              <circle cx="40" cy="40" r="14" fill="#fff" stroke="#168B82" strokeWidth="2.5" />
              <circle cx="100" cy="40" r="10" fill="#E5F4F0" stroke="#168B82" strokeWidth="2" />
              <circle cx="160" cy="40" r="14" fill="#fff" stroke="#4779B8" strokeWidth="2.5" />
            </svg>
          </Reveal>

          <Reveal delay={0.05}>
            <h2 className="h2">
              Technology should bring generations{" "}
              <span className="text-gradient">closer, not push them apart.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-6 text-xl leading-relaxed text-muted">
              We believe growing older should come with more confidence, more
              connection, and more freedom. Sahaya is our step toward a future where
              intelligent technology supports independence while helping families stay
              close, wherever they are.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
