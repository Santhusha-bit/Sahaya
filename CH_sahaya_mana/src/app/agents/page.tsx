import type { Metadata } from "next";
import { AGENT_DEFINITIONS } from "@/agents";
import { AGENT_IDS } from "@/agents/base/types";
import { AgentCard } from "@/components/agents/AgentCard";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Agents" };

export default function AgentsPage() {
  return (
    <main>
      <PageHeader
        title="Your agents"
        subtitle="Four separate helpers. Each keeps its own conversations and only shares what you allow."
      />
      <ul className="flex flex-col gap-4 px-5 pb-6">
        {AGENT_IDS.map((id) => {
          const def = AGENT_DEFINITIONS[id];
          const approvals = def.tools.filter((t) => t.risk === "sensitive" || t.requiresApproval).length;
          return (
            <li key={id}>
              <AgentCard
                id={id}
                name={def.displayName}
                tagline={def.tagline}
                detail={`${def.tools.length} skills · ${approvals} may need your OK`}
              />
            </li>
          );
        })}
      </ul>
    </main>
  );
}
