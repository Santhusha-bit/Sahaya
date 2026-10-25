import { NextResponse } from "next/server";
import { createRoom, iceServers } from "@/integrations/webrtc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a WebRTC call room. The caller opens it; the protected person joins by code. */
export async function POST() {
  const room = createRoom();
  return NextResponse.json({ roomId: room.id, iceServers: iceServers() });
}
