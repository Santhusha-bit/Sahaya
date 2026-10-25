import { handleTranscribe } from "@/lib/voice/handlers";
import { voiceDeps } from "@/lib/server/voice";

/** Recorded audio → Cartesia transcript → the agent's existing processVoiceInput. */
export async function POST(req: Request) {
  return handleTranscribe(req, voiceDeps);
}
