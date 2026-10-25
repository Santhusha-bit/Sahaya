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
import { id } from "@/lib/id";
import { getDataLayer } from "@/agents/base/dataLayer";
import { createAgent } from "@/agents/registry";
import { seedMargaretScenario } from "@/agents/guardian/scamScenario";

export const TWILIO_DEMO_USER = "twilio-demo";

export function twilioConfigured(): boolean {
  return !!(process.env.TWILIO_ACCOUNT_SID?.trim() && process.env.TWILIO_AUTH_TOKEN?.trim());
}

/**
 * Outbound SMS result. `backend` is "twilio" only when the message actually left
 * via the live Twilio REST API; otherwise "sandbox" and nothing was sent off the
 * device. Callers must surface this honestly (never claim delivery in sandbox mode).
 */
export interface SmsResult {
  backend: "twilio" | "sandbox";
  sent: boolean;
  /** Twilio message SID when live; a synthetic reference id in sandbox. */
  sid: string;
  to: string | null;
  /** Present when a live send failed, or why sandbox fell back. */
  reason?: string;
}

/** The Twilio sender number, if configured (E.164). */
export function twilioFromNumber(): string | null {
  return process.env.TWILIO_FROM_NUMBER?.trim() || process.env.TWILIO_PHONE_NUMBER?.trim() || null;
}

/** True only when SMS can actually be sent: credentials + a configured sender. */
export function twilioSmsConfigured(): boolean {
  return twilioConfigured() && !!(twilioFromNumber() || process.env.TWILIO_MESSAGING_SERVICE_SID?.trim());
}

/**
 * Send an SMS via the Twilio REST API (Guardian trusted-contact / caregiver alerts
 * and Care medication reminders / refill notices share this one adapter).
 *
 * Honest integration (global rule 1): LIVE only when TWILIO_ACCOUNT_SID +
 * TWILIO_AUTH_TOKEN and a sender (TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER or
 * TWILIO_MESSAGING_SERVICE_SID) are set AND a recipient is known. Otherwise a
 * deterministic sandbox result with the SAME shape (backend "sandbox", sent=false),
 * so an SMS is never faked as delivered. The destination comes from the caller.
 */
export async function sendSms(input: { to?: string | null; body: string }): Promise<SmsResult> {
  const to = input.to?.trim() || null;
  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = twilioFromNumber();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const body = input.body.slice(0, 1600);

  if (!sid || !token || (!from && !messagingServiceSid) || !to) {
    return {
      backend: "sandbox",
      sent: false,
      sid: id("sms"),
      to,
      reason: !twilioConfigured()
        ? "twilio_not_configured"
        : !from && !messagingServiceSid
          ? "no_sender_configured"
          : "no_recipient_number",
    };
  }

  try {
    const params = new URLSearchParams();
    params.set("To", to);
    params.set("Body", body);
    if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
    else params.set("From", from!);
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
      return { backend: "twilio", sent: false, sid: id("sms"), to, reason: `twilio_http_${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = (await res.json()) as { sid?: string };
    return { backend: "twilio", sent: true, sid: data.sid ?? id("sms"), to };
  } catch (err) {
    return { backend: "twilio", sent: false, sid: id("sms"), to, reason: err instanceof Error ? err.message : String(err) };
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
