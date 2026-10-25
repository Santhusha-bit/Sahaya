import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AGENT_DEFINITIONS } from "@/agents";
import { isAgentId } from "@/agents/base/types";
import { getIntegration } from "@/integrations/status";
import { AgentConsole, type AgentConsoleProps } from "@/components/agents/AgentConsole";
import { CareDashboard } from "@/components/care/CareDashboard";
import { CaregiverAccess } from "@/components/care/CaregiverAccess";


export async function generateMetadata({ params }: PageProps<"/agents/[agent]">): Promise<Metadata> {
  const { agent } = await params;
  return { title: isAgentId(agent) ? AGENT_DEFINITIONS[agent].displayName : "Agent" };
}

export default function AgentPage({ params }: PageProps<"/agents/[agent]">) {
  return (
    <Suspense fallback={<p className="p-6 text-lg text-ink-muted">Opening…</p>}>
      <AgentPageContent params={params} />
    </Suspense>
  );
}

async function AgentPageContent({ params }: Pick<PageProps<"/agents/[agent]">, "params">) {
  // Integration status comes from the server environment at request time.
  await connection();
  const { agent } = await params;
  if (!isAgentId(agent)) notFound();
  const def = AGENT_DEFINITIONS[agent];

  const integrationIds = [...new Set(def.tools.flatMap((t) => t.integrations ?? []))];
  const props: AgentConsoleProps = {
    agent,
    name: def.displayName,
    tagline: def.tagline,
    welcome: def.welcome,
    suggestions: def.suggestedCommands,
    skills: def.tools.map((t) => ({
      name: t.name,
      description: t.description,
      needsApproval: t.risk === "sensitive" || Boolean(t.requiresApproval),
    })),
    integrations: [getIntegration("claude"), getIntegration("cartesia"), ...integrationIds.map((id) => getIntegration(id))].map(
      ({ id, name, mode, detail }) => ({ id, name, mode, detail }),
    ),
  };
  if (agent === "care") {
    // Care adds its dashboard (medications, groceries, pantry, caregiver support) below the conversation.
    return (
      <>
        <AgentConsole {...props} />
        <CareDashboard as="self" />
        <CaregiverAccess />
      </>
    );
  }
  return <AgentConsole {...props} />;
}
