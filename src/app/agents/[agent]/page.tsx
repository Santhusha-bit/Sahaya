import { notFound } from "next/navigation";
import { AgentExperience } from "@/components/agents/AgentExperience";
import { agentMeta } from "@/agents/registry";
import { isAgentId } from "@/agents/base/types";

export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!isAgentId(agent)) notFound();
  const meta = agentMeta()[agent];
  return <AgentExperience meta={meta} />;
}
