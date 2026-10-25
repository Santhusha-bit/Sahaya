/**
 * Twilio SMS adapter (outbound caregiver / trusted-contact alerts and Care
 * reminders). Scam-call screening no longer uses Twilio Voice: calls run over
 * WebRTC and are screened by Claude, see integrations/callScreening.ts.
 */

import { id } from "@/lib/id";

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
