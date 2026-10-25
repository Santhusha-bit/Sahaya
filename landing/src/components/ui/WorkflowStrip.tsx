"use client";

import { ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

/** A horizontal animated workflow of labeled steps. */
export function WorkflowStrip({
  steps,
  color,
}: {
  steps: string[];
  color: string;
}) {
  return (
    <div className="mt-12 flex flex-wrap items-center justify-center gap-3">
      {steps.map((step, i) => (
        <Reveal key={step} delay={i * 0.12} className="flex items-center gap-3">
          <span
            className="rounded-full border bg-white px-4 py-2 text-sm font-semibold shadow-sm"
            style={{ borderColor: `${color}40`, color }}
          >
            {step}
          </span>
          {i < steps.length - 1 && (
            <ArrowRight
              className="h-4 w-4 shrink-0 text-faint"
              aria-hidden="true"
            />
          )}
        </Reveal>
      ))}
    </div>
  );
}
