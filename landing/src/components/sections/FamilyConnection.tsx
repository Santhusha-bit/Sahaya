"use client";

import {
  Mic,
  ShieldCheck,
  Pill,
  Sparkles,
  Receipt,
  MessageCircle,
  Lock,
} from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";

const dashboardItems = [
  { icon: ShieldCheck, label: "Recent safety alerts", status: "1 verification pending", color: "#168B82" },
  { icon: Pill, label: "Medication status", status: "Morning dose confirmed", color: "#4779B8" },
  { icon: Sparkles, label: "Wellness summary", status: "Shared with permission", color: "#C98A2E" },
  { icon: Receipt, label: "Financial approvals", status: "1 awaiting review", color: "#5A6ACF" },
  { icon: MessageCircle, label: "Family activity", status: "Call scheduled Sunday", color: "#168B82" },
];

export function FamilyConnection() {
  return (
    <section className="section bg-bg-tint">
      <div className="container-xl">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <span className="eyebrow">Family Connection</span>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="h2 mt-4">
              Independence for your loved ones.{" "}
              <span className="text-gradient">Reassurance for everyone else.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="lead mt-5">
              The older adult controls every sharing permission and all family
              access. Support, never surveillance.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid items-center gap-8 lg:grid-cols-[0.8fr_auto_1fr]">
          {/* Older adult experience */}
          <Reveal className="flex flex-col items-center">
            <span className="pill mb-4">Older adult experience</span>
            <div className="phone w-[240px]">
              <div className="absolute left-1/2 top-[18px] z-20 h-[18px] w-[76px] -translate-x-1/2 rounded-full bg-[#0d1b24]" />
              <div className="phone-screen flex flex-col items-center px-5 pb-6 pt-14" style={{ minHeight: 420 }}>
                <p className="text-xs font-semibold uppercase tracking-wider text-brand-ink">Sahaya</p>
                <h3 className="mt-2 text-center text-xl font-extrabold text-ink">
                  Good afternoon, Margaret.
                </h3>
                <div className="my-6 flex h-24 w-24 items-center justify-center rounded-full text-white shadow-brand"
                  style={{ background: "linear-gradient(135deg,#19A396,#168B82)" }}>
                  <Mic className="h-9 w-9" aria-hidden="true" />
                </div>
                <div className="w-full space-y-2.5">
                  <div className="rounded-xl bg-soft px-3.5 py-3 text-sm font-medium text-brand-ink">
                    Time for your afternoon walk
                  </div>
                  <div className="rounded-xl border border-line bg-white px-3.5 py-3 text-sm font-medium text-ink">
                    Call with Sarah at 5:00 PM
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* Connector */}
          <Reveal delay={0.1} className="flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div
                className="hidden h-0.5 w-20 lg:block"
                style={{ background: "linear-gradient(90deg, var(--color-brand), var(--color-blue))" }}
                aria-hidden="true"
              />
              <span className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-bold text-brand-ink shadow-sm">
                <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                Permission-based
              </span>
              <div
                className="hidden h-0.5 w-20 lg:block"
                style={{ background: "linear-gradient(90deg, var(--color-blue), var(--color-brand))" }}
                aria-hidden="true"
              />
            </div>
          </Reveal>

          {/* Family dashboard */}
          <Reveal delay={0.15}>
            <span className="pill mb-4">Family experience</span>
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
                <p className="font-bold text-ink">Family dashboard</p>
                <span className="pill">Live</span>
              </div>
              <ul className="divide-y divide-line">
                {dashboardItems.map((item) => (
                  <li key={item.label} className="flex items-center gap-3 px-5 py-3.5">
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: `${item.color}18`, color: item.color }}
                    >
                      <item.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">{item.label}</p>
                      <p className="text-xs text-muted">{item.status}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
