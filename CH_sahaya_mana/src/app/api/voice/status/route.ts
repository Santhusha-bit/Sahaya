import { connection } from "next/server";
import { getVoiceStatus } from "@/lib/server/voice";

/** Which voice provider the app is really using right now (no secrets). */
export async function GET() {
  await connection();
  return Response.json(getVoiceStatus(), { headers: { "Cache-Control": "no-store" } });
}
