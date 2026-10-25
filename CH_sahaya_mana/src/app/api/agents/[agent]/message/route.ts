import type { NextRequest } from "next/server";
import { z } from "zod";
import { isAgentId } from "@/agents/base/types";
import { errorResponse } from "@/lib/server/http";
import { getRuntime } from "@/lib/server/runtime";
import { getSessionContext } from "@/lib/server/session";

const body = z.object({
  text: z.string().min(1).max(8000),
  channel: z.enum(["text", "voice"]).default("text"),
  confidence: z.number().min(0).max(1).optional(),
});

export async function POST(req: NextRequest, ctx: RouteContext<"/api/agents/[agent]/message">) {
  const { agent } = await ctx.params;
  if (!isAgentId(agent)) return Response.json({ error: "Unknown agent" }, { status: 404 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const session = await getSessionContext();
    const runtime = await getRuntime(session);
    const target = runtime.get(agent);
    const { text, channel, confidence } = parsed.data;
    const turn =
      channel === "voice"
        ? await target.processVoiceInput(session, { transcript: text, confidence })
        : await target.processMessage(session, text);
    return Response.json(turn);
  } catch (err) {
    return errorResponse(err);
  }
}
