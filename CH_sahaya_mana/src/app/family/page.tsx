import type { Metadata } from "next";
import { AGENT_DEFINITIONS } from "@/agents";
import { AGENT_IDS } from "@/agents/base/types";
import { AGENT_THEME } from "@/components/agents/agentTheme";
import { CareFamilySection } from "@/components/care/CareDashboard";
import { EmptyState, PageHeader, Section } from "@/components/ui";

export const metadata: Metadata = { title: "Family" };

const SECTION_TITLE = {
  guardian: "Guardian alerts",
  care: "Care reminders & tasks",
  wellness: "Wellness summaries",
  finance: "Finance approvals",
} as const;

export default function FamilyPage() {
  return (
    <main>
      <PageHeader
        title="Family"
        subtitle="Updates your caregivers can see — only what you choose to share."
      />
      {AGENT_IDS.map((id) =>
        id === "care" ? (
          <section key={id} className="py-3">
            <h2 className="mb-2 px-5 text-xl font-bold">{SECTION_TITLE[id]}</h2>
            <CareFamilySection />
          </section>
        ) : (
        <Section key={id} title={SECTION_TITLE[id]}>
          <EmptyState>
            <span className={`font-bold ${AGENT_THEME[id].text}`}>{AGENT_DEFINITIONS[id].displayName}</span> isn&apos;t
            sharing anything with caregivers. Caregiver access and consent settings are coming in a later update.
          </EmptyState>
        </Section>
        ),
      )}
    </main>
  );
}
