import { handleStreamHealth } from "@/lib/voice/handlers";
import { voiceDeps } from "@/lib/server/voice";

/** The browser reports whether streaming worked (no audio or text), so status stays honest. */
export async function POST(req: Request) {
  return handleStreamHealth(req, voiceDeps);
}
