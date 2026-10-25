import type { NextRequest } from "next/server";
import { isAgentId } from "@/agents/base/types";
import { errorResponse } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { getSessionContext } from "@/lib/server/session";

/** One agent's conversation, active tasks and pending approvals — nothing from other agents. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/agents/[agent]/state">) {
  const { agent } = await ctx.params;
  if (!isAgentId(agent)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const session = await getSessionContext();
    const target = (await getRuntime(session)).get(agent);
    const [messages, tasks, approvals] = await Promise.all([
      target.listConversation(session),
      target.listTasks(session),
      target.listApprovals(session),
    ]);
    return Response.json({
      messages: messages.map(({ id, role, text, channel, at }) => ({ id, role, text, channel, at })),
      tasks: tasks.slice(0, 10),
      approvals: approvals.map(({ id, summary, toolName, createdAt, expiresAt, status }) => ({
        id,
        summary,
        toolName,
        createdAt,
        expiresAt,
        status,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
