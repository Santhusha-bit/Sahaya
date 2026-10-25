"use client";

import { Sparkles, Moon, Heart } from "lucide-react";
import { FeatureLayout } from "@/components/ui/FeatureLayout";
import { ChatPhone } from "@/components/ui/ChatPhone";
import { Reveal } from "@/components/ui/Reveal";
import { IllustrativeBadge } from "@/components/ui/IllustrativeBadge";
import { CAPABILITIES } from "@/data/capabilities";

const cap = CAPABILITIES.wellness;

const blocks = [
  {
    label: "Capability A",
    title: "Conversational wellness intelligence",
    features: [
      "Natural voice conversations",
      "Extraction of self-reported observations",
      "Personalized memory & intelligent follow-ups",
    ],
  },
  {
    label: "Capability B",
    title: "Behavioral pattern recognition",
    features: [
      "Personalized routine baselines",
      "Longitudinal analysis of self-reported changes",
      "Permission-based family wellness summaries",
    ],
  },
  {
    label: "Capability C",
    title: "Emotional wellness & connection",
    features: [
      "Supportive conversations",
      "Recognition of expressed loneliness",
      "Family call coordination",
    ],
  },
];

const timeline = [
  { day: "Monday", note: "Normal energy reported", tone: "#4779B8" },
  { day: "Wednesday", note: "Poor sleep reported", tone: "#C98A2E" },
  { day: "Friday", note: "Reduced appetite reported", tone: "#C98A2E" },
  { day: "Sunday", note: "Continued fatigue reported", tone: "#D97757" },
];

export function Wellness() {
  return (
    <FeatureLayout
      id="wellness"
      index={cap.index}
      name={cap.name}
      icon={cap.icon}
      color={cap.color}
      tint={cap.tint}
      headline={<>Sometimes, the smallest changes matter most.</>}
      description="Sahaya listens to everyday conversations, remembers what matters, and helps older adults and their families recognize meaningful changes in self-reported well-being."
      note="These are conversational observations, not clinical measurements, and Sahaya is not a diagnostic tool. Wellness summaries are shared with family only with the user's permission."
      visual={
        <div className="relative">
          <span className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
            <IllustrativeBadge />
          </span>
          <ChatPhone
            title="Wellness"
            icon={Sparkles}
            color={cap.color}
            messages={[
              { from: "user", text: "I haven't been sleeping very well lately." },
              { from: "ai", text: "I'm sorry to hear that. Has something been keeping you awake?" },
            ]}
          >
            <div className="mt-1 rounded-2xl border border-line bg-white p-3">
              <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-wide text-faint">
                Observation noted
              </p>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <Moon className="h-4 w-4" style={{ color: cap.color }} aria-hidden="true" />
                  <span className="font-semibold text-ink">Sleep:</span>
                  <span className="text-muted">Poor sleep reported</span>
                </div>
                <div className="flex items-center gap-2">
                  <Heart className="h-4 w-4" style={{ color: cap.color }} aria-hidden="true" />
                  <span className="font-semibold text-ink">Energy:</span>
                  <span className="text-muted">Follow-up pending</span>
                </div>
              </div>
              <p className="mt-2 border-t border-line pt-2 text-[0.68rem] text-faint">
                Last updated: Today
              </p>
            </div>
          </ChatPhone>
        </div>
      }
      blocks={blocks}
    >
      {/* Wellness timeline visualization */}
      <Reveal>
        <div className="card mx-auto mt-14 max-w-3xl p-6 sm:p-8">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h3 className="h3">A gentle pattern, noticed over time</h3>
            <IllustrativeBadge />
          </div>
          <ol className="relative ml-2 border-l-2 border-line pl-6">
            {timeline.map((t, i) => (
              <Reveal as="li" key={t.day} delay={i * 0.1} className="relative mb-5 last:mb-0">
                <span
                  className="absolute -left-[31px] top-1 h-4 w-4 rounded-full border-2 border-white"
                  style={{ background: t.tone }}
                  aria-hidden="true"
                />
                <p className="text-sm font-bold text-ink">{t.day}</p>
                <p className="text-sm text-muted">{t.note}</p>
              </Reveal>
            ))}
          </ol>
          <div
            className="mt-5 rounded-2xl border px-4 py-3.5 text-sm"
            style={{ borderColor: `${cap.color}40`, background: cap.tint }}
          >
            <p className="font-semibold text-ink">
              Several changes have been mentioned recently.
            </p>
            <p className="mt-0.5 text-muted">
              Would you like to check in, or share a summary with your caregiver?
            </p>
          </div>
        </div>
      </Reveal>
    </FeatureLayout>
  );
}
