import type { LucideIcon } from "lucide-react";
import { Shield, Heart, Sparkles, Receipt } from "lucide-react";

export type CapabilityKey = "guardian" | "care" | "wellness" | "finance";

export type Capability = {
  key: CapabilityKey;
  index: string;
  name: string;
  icon: LucideIcon;
  /** Primary color for the capability accent. */
  color: string;
  tint: string;
  tagline: string;
};

export const CAPABILITIES: Record<CapabilityKey, Capability> = {
  guardian: {
    key: "guardian",
    index: "01",
    name: "Guardian",
    icon: Shield,
    color: "#168B82",
    tint: "#E5F4F0",
    tagline: "Scam protection, safety & emergencies",
  },
  care: {
    key: "care",
    index: "02",
    name: "Care",
    icon: Heart,
    color: "#4779B8",
    tint: "#E8F0FA",
    tagline: "Medication, shopping & everyday help",
  },
  wellness: {
    key: "wellness",
    index: "03",
    name: "Wellness",
    icon: Sparkles,
    color: "#C98A2E",
    tint: "#FBF0DC",
    tagline: "Health insights & emotional support",
  },
  finance: {
    key: "finance",
    index: "04",
    name: "Finance",
    icon: Receipt,
    color: "#5A6ACF",
    tint: "#ECEEFB",
    tagline: "Bills, protection & planning",
  },
};

export const CAPABILITY_ORDER: CapabilityKey[] = [
  "guardian",
  "care",
  "wellness",
  "finance",
];
