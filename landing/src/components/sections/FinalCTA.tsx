"use client";

import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { DEMO_URL } from "@/lib/constants";

export function FinalCTA() {
  const reduce = useReducedMotion();

  return (
    <section className="section relative overflow-hidden" style={{ background: "#0f2231" }}>
      {/* Teal glow */}
      <div
        className="ambient h-[500px] w-[500px]"
        style={{
          background: "#168B82",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          opacity: 0.4,
        }}
      />
      <div className="container-xl relative text-center">
        {/* Animated voice waveform */}
        <div className="mb-8 flex items-end justify-center gap-1.5" aria-hidden="true">
          {[0.4, 0.7, 1, 0.6, 0.9, 0.5, 0.8, 0.45].map((h, i) => (
            <motion.span
              key={i}
              className="w-1.5 rounded-full"
              style={{ backgroundColor: "#2fc5b6" }}
              initial={{ height: 8 }}
              animate={reduce ? { height: 20 } : { height: [8, 36 * h, 8] }}
              transition={{
                duration: 1.1,
                repeat: reduce ? 0 : Infinity,
                delay: i * 0.1,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        <Reveal>
          <h2 className="h2 mx-auto max-w-3xl text-white">
            A safer, simpler tomorrow starts with{" "}
            <span className="bg-gradient-to-r from-[#5fe0d2] to-[#8fb9e8] bg-clip-text text-transparent">
              a conversation.
            </span>
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70">
            Discover how Sahaya brings safety, everyday assistance, wellness awareness,
            and financial confidence together in one intelligent companion.
          </p>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <a href={DEMO_URL} className="btn btn-primary">
              Experience Sahaya Now
              <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
            </a>
            <a
              href="#technology"
              className="btn border border-white/40 bg-transparent text-white hover:bg-white hover:text-ink"
            >
              Explore Our Technology
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
