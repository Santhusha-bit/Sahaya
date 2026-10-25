import { NextResponse } from "next/server";
import { synthesizeSpeech, type VoicePersona } from "@/integrations/cartesia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERSONAS: VoicePersona[] = ["guardian", "scam-caller"];

/** Text-to-speech. Returns audio when Cartesia is configured, else 204 so the
 *  client uses the browser SpeechSynthesis fallback. */
export async function POST(req: Request) {
  let body: { text?: string; voiceId?: string; persona?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const persona = PERSONAS.find((p) => p === body.persona);

  const result = await synthesizeSpeech(text, body.voiceId, { persona });
  if (!result) return new NextResponse(null, { status: 204, headers: { "X-Voice-Mode": "browser" } });

  return new NextResponse(result.audio, {
    status: 200,
    headers: { "Content-Type": result.contentType, "X-Voice-Mode": "cartesia" },
  });
}
