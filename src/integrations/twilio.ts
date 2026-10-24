/**
 * Twilio Voice adapter (scam-call demo).
 *
 * Someone dials the Twilio number, Guardian greets them, captures what the
 * suspicious caller/message said (Twilio speech recognition), runs the SAME
 * deterministic scam screening used everywhere else, and speaks the warning back.
 *
 * Honest integration (global rule 1): LIVE only with TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN; otherwise the status page shows Twilio as "unavailable" and
 * the browser voice mic is the fallback demo. Inbound webhooks are untrusted, so
 * requests are verified with the Twilio signature before anything runs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { getDataLayer } from "@/agents/base/dataLayer";
import { createAgent } from "@/agents/registry";
import { seedMargaretScenario } from "@/agents/guardian/scamScenario";

export const TWILIO_DEMO_USER = "twilio-demo";

export function twilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim());
}

/** XML-escape text before placing it inside TwiML <Say>. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const VOICE = 'voice="Polly.Joanna" language="en-US"';

/** Greeting + a speech Gather that posts the transcript to the screen route. */
export function greetingTwiml(action = "/api/voice/twilio/screen"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST">
    <Say ${VOICE}>Hi, this is Guardian, your safety helper. Tell me what the suspicious caller or message said, and I'll check whether it's a scam.</Say>
  </Gather>
  <Say ${VOICE}>I didn't catch anything. Please call back when you're ready. Goodbye.</Say>
</Response>`;
}

/** Speak the screening result, then offer to check another message. */
export function resultTwiml(warning: string, action = "/api/voice/twilio/screen"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say ${VOICE}>${xmlEscape(warning)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST">
    <Say ${VOICE}>If there's another message to check, tell me now. Otherwise you can hang up.</Say>
  </Gather>
  <Say ${VOICE}>Stay safe. Goodbye.</Say>
</Response>`;
}

export function repromptTwiml(action = "/api/voice/twilio/screen"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" speechTimeout="auto" action="${action}" method="POST">
    <Say ${VOICE}>Sorry, I didn't hear that. Please tell me what the suspicious message said.</Say>
  </Gather>
  <Say ${VOICE}>Goodbye.</Say>
</Response>`;
}

/**
 * Validate Twilio's X-Twilio-Signature per the documented algorithm: HMAC-SHA1 of
 * (full URL + each POST param key immediately followed by its value, keys sorted),
 * keyed by the auth token, base64-encoded.
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  authToken: string,
): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guard for inbound Twilio webhooks. Returns true if the request is allowed:
 * - no auth token configured (sandbox) -> allowed (no credential to verify with)
 * - TWILIO_VALIDATE=off -> allowed (local debugging behind proxies)
 * - otherwise the X-Twilio-Signature must verify.
 */
export function twilioSignatureValid(req: Request, params: Record<string, string>): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!token) return true;
  if (process.env.TWILIO_VALIDATE === "off") return true;
  return validateTwilioSignature(requestPublicUrl(req), params, req.headers.get("x-twilio-signature"), token);
}

/** Read a Twilio form-encoded webhook body into a plain string map. */
export async function readTwilioForm(req: Request): Promise<Record<string, string>> {
  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

/** Reconstruct the public URL Twilio signed, honoring proxy headers (ngrok). */
export function requestPublicUrl(req: Request): string {
  const configured = process.env.TWILIO_PUBLIC_URL?.trim();
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const base = configured ? configured.replace(/\/$/, "") : `${proto}://${host}`;
  return `${base}${u.pathname}`;
}

async function ensureSeeded(userId: string): Promise<void> {
  const data = getDataLayer();
  const existing = await data.memory.list({ namespace: "shared", userId, collection: "trustedContacts", limit: 1 });
  if (!existing.length) await seedMargaretScenario(data, userId);
}

/**
 * Run the deterministic Guardian screening on the caller's transcript and return
 * a short spoken warning. No model call is required, so it is fast and reliable
 * for a phone call and works even without an Anthropic key.
 */
export async function screenSpeech(userId: string, speech: string): Promise<string> {
  const text = speech.trim();
  if (!text) return "";
  await ensureSeeded(userId);
  const guardian = createAgent("guardian", { data: getDataLayer(), userId });
  await guardian.initialize();
  const { result } = await guardian.executeTool("screenInboundMessage", {
    content: text,
    channel: "phone",
    claimant: undefined,
  });
  return result.summary;
}
