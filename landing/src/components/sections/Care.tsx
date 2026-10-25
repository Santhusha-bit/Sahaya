"use client";

import { Heart, Pill } from "lucide-react";
import { FeatureLayout } from "@/components/ui/FeatureLayout";
import { ChatPhone } from "@/components/ui/ChatPhone";
import { IllustrativeBadge } from "@/components/ui/IllustrativeBadge";
import { CAPABILITIES } from "@/data/capabilities";

const cap = CAPABILITIES.care;

const blocks = [
  {
    label: "Capability A",
    title: "Intelligent medication management",
    features: [
      "Personalized voice medication reminders",
      "Confirmation & missed-dose identification",
      "Refill request preparation + caregiver alerts",
    ],
  },
  {
    label: "Capability B",
    title: "Groceries & essential supplies",
    features: [
      "Voice-powered shopping lists & preferences",
      "Suggested substitutions & price comparison",
      "Cart prepared, approval required before purchase",
    ],
  },
  {
    label: "Capability C",
    title: "Nutrition & meal assistance",
    features: [
      "Personalized meal suggestions & pantry tracking",
      "Food expiration reminders",
      "Voice-guided cooking assistance",
    ],
  },
];

export function Care() {
  return (
    <FeatureLayout
      id="care"
      index={cap.index}
      name={cap.name}
      icon={cap.icon}
      color={cap.color}
      tint={cap.tint}
      reverse
      headline={<>Everyday care, made effortless.</>}
      description="From medication reminders to groceries and meals, Sahaya helps simplify the routines that make independent living possible."
      note="Sahaya does not prescribe medication, change dosages, or confirm ingestion without the user's input. Purchases always require the user's authorization."
      visual={
        <div className="relative">
          <span className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
            <IllustrativeBadge />
          </span>
          <ChatPhone
            title="Care"
            icon={Heart}
            color={cap.color}
            messages={[
              { from: "ai", text: "Good morning, Margaret. Have you taken your morning medication?" },
              { from: "user", text: "Not yet. I think I only have two pills left." },
              {
                from: "ai",
                text: "Thanks for letting me know. I'll record that and help prepare a refill request.",
              },
            ]}
          >
            <div className="mt-1 space-y-2">
              <div className="flex items-center justify-between rounded-2xl border border-line bg-white px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <Pill className="h-5 w-5" style={{ color: cap.color }} aria-hidden="true" />
                  <div className="text-xs">
                    <p className="font-bold text-ink">Morning medication</p>
                    <p className="text-muted">2 pills remaining</p>
                  </div>
                </div>
                <span className="pill" style={{ background: cap.tint }}>Tracked</span>
              </div>
              <div
                className="rounded-2xl border px-3 py-2.5 text-xs"
                style={{ borderColor: `${cap.color}40`, background: cap.tint }}
              >
                <p className="font-bold text-ink">Refill request</p>
                <p className="text-muted">Drafted, awaiting your approval</p>
              </div>
            </div>
          </ChatPhone>
        </div>
      }
      blocks={blocks}
    />
  );
}
