"use client";

import { Shield, PhoneIncoming } from "lucide-react";
import { FeatureLayout } from "@/components/ui/FeatureLayout";
import { ChatPhone } from "@/components/ui/ChatPhone";
import { WorkflowStrip } from "@/components/ui/WorkflowStrip";
import { IllustrativeBadge } from "@/components/ui/IllustrativeBadge";
import { CAPABILITIES } from "@/data/capabilities";

const cap = CAPABILITIES.guardian;

const blocks = [
  {
    label: "Capability A",
    title: "Scam & personal security protection",
    features: [
      "Real-time scam intervention on supported channels",
      "Identity verification through trusted contacts",
      "Recognizes phishing, suspicious links & data requests",
    ],
  },
  {
    label: "Capability B",
    title: "Emergency & rapid assistance",
    features: [
      "Voice-activated SOS",
      "Intelligent help coordination & family notifications",
      "Acknowledgment tracking with escalation",
    ],
  },
  {
    label: "Capability C",
    title: "On-demand human assistance",
    features: [
      "Household & technology help requests",
      "Authorized caregiver coordination",
      "Appointment scheduling with reminders",
    ],
  },
];

export function Guardian() {
  return (
    <FeatureLayout
      id="features"
      index={cap.index}
      name={cap.name}
      icon={cap.icon}
      color={cap.color}
      tint={cap.tint}
      headline={<>Protection when it matters most.</>}
      description="Sahaya helps older adults recognize suspicious interactions, respond to emergencies, and connect with trusted people when assistance is needed."
      note="Sahaya does not automatically intercept every phone call or conclusively identify cloned voices, and it does not dispatch emergency services itself. For emergencies, always call your local emergency number."
      visual={
        <div className="relative">
          <span className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
            <IllustrativeBadge />
          </span>
          <ChatPhone
            title="Guardian"
            icon={Shield}
            color={cap.color}
            messages={[
              { from: "ai", text: "Incoming call: caller claims to be your grandson." },
              { from: "user", text: "He says he needs $1,500 right now and not to tell anyone." },
              {
                from: "ai",
                text: "This request may be suspicious. Let's verify it using a trusted contact before taking any action.",
              },
            ]}
          >
            <div
              className="mt-1 flex items-center gap-2.5 rounded-2xl border px-3 py-2.5"
              style={{ borderColor: `${cap.color}40`, background: cap.tint }}
            >
              <PhoneIncoming className="h-5 w-5" style={{ color: cap.color }} aria-hidden="true" />
              <div className="text-xs">
                <p className="font-bold text-ink">Verification recommended</p>
                <p className="text-muted">No action taken yet</p>
              </div>
            </div>
          </ChatPhone>
        </div>
      }
      blocks={blocks}
    >
      <WorkflowStrip
        color={cap.color}
        steps={[
          "Suspicious request",
          "Safety warning",
          "Independent verification",
          "Family notification",
        ]}
      />
    </FeatureLayout>
  );
}
