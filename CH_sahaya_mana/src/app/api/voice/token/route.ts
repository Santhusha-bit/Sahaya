import { handleToken } from "@/lib/voice/handlers";
import { voiceDeps } from "@/lib/server/voice";

/** Short-lived Cartesia access token for the browser's streaming sockets (the API key never leaves the server). */
export async function POST(req: Request) {
  return handleToken(req, voiceDeps);
}
