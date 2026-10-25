import { NextResponse } from "next/server";
import { screenCallTranscript } from "@/integrations/callScreening";
import { getRoom } from "@/integrations/webrtc";
import { getCurrentUser } from "@/lib/user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Screen the caller's rolling transcript for a live WebRTC call. Called by the
 * protected person's browser as captions arrive over the data channel.
 */
export async function POST(req: Request, { params }: { params: Promise<{ room: string }> }) {
  const { room: roomId } = await params;
  if (!getRoom(roomId)) return NextResponse.json({ error: "room_not_found" }, { status: 404 });

  let body: { transcript?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) return NextResponse.json({ error: "transcript required" }, { status: 400 });

  const result = await screenCallTranscript({ callId: roomId, userId: getCurrentUser().id, transcript });
  return NextResponse.json(result);
}
