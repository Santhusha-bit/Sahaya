import type { AgentId } from "@/agents/base/types";

/** Static class names per agent (kept literal so Tailwind can see them). */
export const AGENT_THEME: Record<
  AgentId,
  { text: string; bg: string; soft: string; border: string; hoverBorder: string; ring: string; label: string }
> = {
  guardian: {
    text: "text-guardian",
    bg: "bg-guardian",
    soft: "bg-guardian-soft",
    border: "border-guardian",
    hoverBorder: "hover:border-guardian",
    ring: "ring-guardian",
    label: "Safety",
  },
  care: {
    text: "text-care",
    bg: "bg-care",
    soft: "bg-care-soft",
    border: "border-care",
    hoverBorder: "hover:border-care",
    ring: "ring-care",
    label: "Everyday care",
  },
  wellness: {
    text: "text-wellness",
    bg: "bg-wellness",
    soft: "bg-wellness-soft",
    border: "border-wellness",
    hoverBorder: "hover:border-wellness",
    ring: "ring-wellness",
    label: "Wellbeing",
  },
  finance: {
    text: "text-finance",
    bg: "bg-finance",
    soft: "bg-finance-soft",
    border: "border-finance",
    hoverBorder: "hover:border-finance",
    ring: "ring-finance",
    label: "Money",
  },
};
