import { NextResponse } from "next/server";
import { getRoom, hangUp, iceServers, isSessionDescription, postDescription } from "@/integrations/webrtc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Poll a room's signaling state (offer, answer, hung up). */
export async function GET(_req: Request, { params }: { params: Promise<{ room: string }> }) {
  const { room: roomId } = await params;
  const room = getRoom(roomId);
  if (!room) return NextResponse.json({ error: "room_not_found" }, { status: 404 });
  return NextResponse.json({
    roomId: room.id,
    offer: room.offer,
    answer: room.answer,
    hungUp: room.hungUp,
    iceServers: iceServers(),
  });
}

/** Post an SDP offer/answer (`{ description }`) or end the call (`{ hangup: true }`). */
export async function POST(req: Request, { params }: { params: Promise<{ room: string }> }) {
  const { room: roomId } = await params;
  let body: { description?: unknown; hangup?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.hangup) {
    return hangUp(roomId)
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "room_not_found" }, { status: 404 });
  }

  if (!isSessionDescription(body.description)) {
    return NextResponse.json({ error: "description must be an SDP offer or answer" }, { status: 400 });
  }
  const res = postDescription(roomId, body.description);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.error === "room_not_found" ? 404 : 409 });
  }
  return NextResponse.json({ ok: true });
}
