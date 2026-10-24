import { NextResponse } from "next/server";
import { greetingTwiml, readTwilioForm, twilioSignatureValid } from "@/integrations/twilio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twiml(xml: string, status = 200) {
  return new NextResponse(xml, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

/** Inbound call entry point (set this as the Twilio number's Voice webhook). */
export async function POST(req: Request) {
  const params = await readTwilioForm(req);
  if (!twilioSignatureValid(req, params)) {
    return NextResponse.json({ error: "Invalid Twilio signature" }, { status: 403 });
  }
  return twiml(greetingTwiml());
}

/** Convenience: lets you preview the greeting TwiML in a browser. */
export async function GET() {
  return twiml(greetingTwiml());
}
