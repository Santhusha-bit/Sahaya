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

/**
 * Outbound SMS result. `channel` is "sms" only when the message actually left via
 * the live Twilio REST API; otherwise it is "sandbox" and nothing was sent off the
 * device. Callers must surface this honestly (never claim an SMS was delivered in
 * sandbox mode).
 */
export interface SmsResult {
  channel: "sms" | "sandbox";
  delivered: boolean;
  /** Twilio message SID when live, else a local reference id. */
  sid?: string;
  /** Present when a live send failed; the caller should fall back gracefully. */
  error?: string;
}

/** True only when SMS can actually be sent: credentials + a configured sender. */
export function twilioSmsConfigured(): boolean {
  return twilioConfigured() && !!(process.env.TWILIO_FROM_NUMBER?.trim() || process.env.TWILIO_MESSAGING_SERVICE_SID?.trim());
}

/**
 * Send an SMS via the Twilio REST API.
 *
 * Honest integration (global rule 1): LIVE only when TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN and a sender (TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID)
 * are set. Otherwise this is a deterministic sandbox no-op with the SAME interface
 * (returns channel "sandbox", delivered=false) so nothing is ever faked as delivered.
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const dest = to.trim();

  if (!sid || !token || (!from && !messagingServiceSid) || !dest) {
    return { channel: "sandbox", delivered: false, sid: `sandbox-sms-${Date.now()}` };
  }

  const params = new URLSearchParams();
  params.set("To", dest);
  params.set("Body", body.slice(0, 1600));
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else params.set("From", from!);

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { channel: "sandbox", delivered: false, error: `twilio_http_${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = (await res.json()) as { sid?: string };
    return { channel: "sms", delivered: true, sid: data.sid };
  } catch (err) {
    return { channel: "sandbox", delivered: false, error: String(err) };
  }
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
