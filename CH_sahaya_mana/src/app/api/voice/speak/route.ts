import { handleSpeak } from "@/lib/voice/handlers";
import { voiceDeps } from "@/lib/server/voice";

/** Plain text (≤ 1,000 chars) → Cartesia MP3. The key stays on the server. */
export async function POST(req: Request) {
  return handleSpeak(req, voiceDeps);
}
