import { NextResponse } from "next/server";
import { createSttSession } from "@/integrations/cartesia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Short-lived, STT-only Cartesia session for the browser (live call captions).
 * The API key stays on the server; the token can only transcribe and expires.
 * 204 when Cartesia isn't configured, so the client falls back to browser captions.
 */
export async function POST() {
  const session = await createSttSession();
  if (!session) return new NextResponse(null, { status: 204, headers: { "X-Stt-Mode": "browser" } });
  return NextResponse.json(session, { headers: { "Cache-Control": "no-store" } });
}
