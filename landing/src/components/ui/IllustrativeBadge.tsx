import { Sparkles } from "lucide-react";

/** Honest label marking simulated, illustrative product scenarios. */
export function IllustrativeBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-bg-tint px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-wide text-faint ${className}`}
    >
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      Illustrative example
    </span>
  );
}
