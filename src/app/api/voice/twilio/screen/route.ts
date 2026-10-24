import { NextResponse } from "next/server";
import {
  readTwilioForm,
  repromptTwiml,
  resultTwiml,
  screenSpeech,
  twilioSignatureValid,
  TWILIO_DEMO_USER,
} from "@/integrations/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twiml(xml: string, status = 200) {
  return new NextResponse(xml, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

/** Receives Twilio's speech transcript, screens it, and speaks the warning. */
export async function POST(req: Request) {
  const params = await readTwilioForm(req);
  if (!twilioSignatureValid(req, params)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }
  const speech = (params.SpeechResult ?? "").trim();
  if (!speech) return twiml(repromptTwiml());

  const warning = await screenSpeech(TWILIO_DEMO_USER, speech);
  return twiml(resultTwiml(warning || "I couldn't analyze that clearly. Please never send money or codes because of a phone call."));
}
