import type { Metadata } from "next";
import { EmptyState, PageHeader, Section } from "@/components/ui";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return (
    <main>
      <PageHeader title="Activity" subtitle="Everything your agents have done, in one place." />
      <Section title="Recent">
        <EmptyState>
          The combined activity feed (each agent&apos;s actions and the messages agents send each other) is coming in a
          later update. Open an agent to see its own tasks for now.
        </EmptyState>
      </Section>
    </main>
  );
}
