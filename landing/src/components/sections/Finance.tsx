"use client";

import { Receipt, AlertCircle, Lock } from "lucide-react";
import { FeatureLayout } from "@/components/ui/FeatureLayout";
import { Reveal } from "@/components/ui/Reveal";
import { PhoneFrame } from "@/components/ui/PhoneFrame";
import { IllustrativeBadge } from "@/components/ui/IllustrativeBadge";
import { CAPABILITIES } from "@/data/capabilities";

const cap = CAPABILITIES.finance;

const blocks = [
  {
    label: "Capability A & B",
    title: "Bill, insurance & invoice review",
    features: [
      "Reviews medical bills & care-facility invoices",
      "Flags possible duplicate or inconsistent charges",
      "Prepares dispute & clarification drafts",
    ],
  },
  {
    label: "Capability C & D",
    title: "Bills, subscriptions & financial guardian",
    features: [
      "Tracks upcoming bills & unused subscriptions",
      "Flags unusual activity on authorized data",
      "Requests approval before sensitive actions",
    ],
  },
  {
    label: "Capability E & F",
    title: "Benefits & long-term planning",
    features: [
      "Identifies potentially relevant assistance programs",
      "Prepares eligibility & application checklists",
      "Models income & future care costs transparently",
    ],
  },
];

export function Finance() {
  return (
    <FeatureLayout
      id="finance"
      index={cap.index}
      name={cap.name}
      icon={cap.icon}
      color={cap.color}
      tint={cap.tint}
      reverse
      headline={<>Financial confidence, without the complexity.</>}
      description="Sahaya helps older adults understand expenses, review bills, identify possible issues, and manage financial tasks while keeping sensitive actions under their control."
      note="Sahaya never transfers money, pays bills, or submits a dispute on its own. Sensitive actions always require the user's explicit authorization."
      visual={
        <div className="relative">
          <span className="absolute -top-3 left-1/2 z-30 -translate-x-1/2">
            <IllustrativeBadge />
          </span>
          <PhoneFrame>
            <div className="flex flex-col px-4 pb-5 pt-12">
              <div className="flex items-center gap-2.5 border-b border-line pb-3">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{ background: `${cap.color}1a`, color: cap.color }}
                >
                  <Receipt className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-bold text-ink">Finance</p>
                  <p className="text-[0.68rem] text-muted">Invoice review</p>
                </div>
              </div>

              {/* Invoice */}
              <div className="mt-4 rounded-2xl border border-line bg-white p-4">
                <p className="text-[0.7rem] font-bold uppercase tracking-wide text-faint">
                  Medical invoice
                </p>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Invoice total</span>
                    <span className="font-bold text-ink">$420.00</span>
                  </div>
                  <div
                    className="flex items-center justify-between rounded-xl px-2.5 py-2"
                    style={{ background: cap.tint }}
                  >
                    <span className="flex items-center gap-1.5 font-semibold" style={{ color: cap.color }}>
                      <AlertCircle className="h-4 w-4" aria-hidden="true" />
                      Possible duplicate
                    </span>
                    <span className="font-bold" style={{ color: cap.color }}>$85.00</span>
                  </div>
                </div>
              </div>

              <p className="mt-3 text-[0.82rem] leading-snug text-muted">
                I found a charge that may need clarification. Would you like me to
                prepare a review request?
              </p>

              {/* Actions */}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-line bg-white py-2.5 text-xs font-bold text-ink"
                >
                  Review charge
                </button>
                <button
                  type="button"
                  className="rounded-xl py-2.5 text-xs font-bold text-white"
                  style={{ background: cap.color }}
                >
                  Prepare dispute
                </button>
              </div>
              <p className="mt-2.5 flex items-center justify-center gap-1.5 text-[0.7rem] font-semibold text-faint">
                <Lock className="h-3 w-3" aria-hidden="true" />
                Approval required before any action
              </p>
            </div>
          </PhoneFrame>
        </div>
      }
      blocks={blocks}
    >
      <Reveal>
        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-muted">
          Benefits Navigator supports prescription, food, utility, and healthcare
          assistance research, and all projections present their assumptions
          transparently.
        </p>
      </Reveal>
    </FeatureLayout>
  );
}
