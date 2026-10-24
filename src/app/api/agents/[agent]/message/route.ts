import { NextResponse } from "next/server";
import { AgentService } from "@/agents/service";
import { isAgentId } from "@/agents/base/types";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!isAgentId(agent)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });

  let body: { text?: string; via?: "voice" | "text"; stream?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "Message text is required" }, { status: 400 });

  const user = getCurrentUser();
  const service = await AgentService.forUser(user.id);
  const via = body.via ?? "text";

  // Streaming (SSE): the client sees reply tokens as they are generated.
  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sse = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        try {
          const { reply, deliveredEvents } = await service.streamMessage(agent, text, via, (delta) =>
            sse("token", { t: delta }),
          );
          const state = await service.agentState(agent);
          sse("done", { reply, deliveredEvents, ...state });
        } catch (err) {
          sse("error", { message: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const { reply, deliveredEvents } = await service.sendMessage(agent, text, via);
  const state = await service.agentState(agent);
  return NextResponse.json({ reply, deliveredEvents, ...state });
}
