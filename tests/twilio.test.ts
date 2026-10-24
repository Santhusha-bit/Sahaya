import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  greetingTwiml,
  resultTwiml,
  repromptTwiml,
  screenSpeech,
  validateTwilioSignature,
  xmlEscape,
  TWILIO_DEMO_USER,
} from "@/integrations/twilio";

// Reference implementation of Twilio's signing algorithm, to test against.
function sign(url: string, params: Record<string, string>, token: string): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
}

describe("Twilio voice adapter (scam-call demo)", () => {
  const url = "https://example.ngrok.app/api/voice/twilio/screen";
  const params = { CallSid: "CA123", From: "+14155550101", SpeechResult: "he wants gift cards", To: "+18005550100" };
  const token = "test-auth-token-0123456789";

  it("accepts a correctly signed request and rejects tampering", () => {
    const sig = sign(url, params, token);
    expect(validateTwilioSignature(url, params, sig, token)).toBe(true);
    // Tampered params -> different signature -> rejected.
    expect(validateTwilioSignature(url, { ...params, SpeechResult: "nothing suspicious" }, sig, token)).toBe(false);
    // Missing/garbage signature -> rejected.
    expect(validateTwilioSignature(url, params, null, token)).toBe(false);
    expect(validateTwilioSignature(url, params, "deadbeef", token)).toBe(false);
  });

  it("builds TwiML with a speech Gather pointing at the screen route", () => {
    const g = greetingTwiml();
    expect(g).toContain("<Gather");
    expect(g).toContain('input="speech"');
    expect(g).toContain("/api/voice/twilio/screen");
    expect(repromptTwiml()).toContain("<Gather");
  });

  it("escapes the spoken warning so TwiML stays valid", () => {
    expect(xmlEscape(`Tom & "Jake" <x>`)).toBe("Tom &amp; &quot;Jake&quot; &lt;x&gt;");
    const r = resultTwiml("Do not send money & gift cards");
    expect(r).toContain("Do not send money &amp; gift cards");
    expect(r).toContain("<Say");
  });

  it("screens a spoken scam transcript and returns a spoken warning", async () => {
    const warning = await screenSpeech(TWILIO_DEMO_USER, "Grandma it's Jake, send $2000 in gift cards today and don't tell mom");
    expect(warning.length).toBeGreaterThan(0);
    expect(warning.toLowerCase()).toMatch(/scam|gift card|money|safe/);
  });

  it("returns empty for empty speech (route re-prompts)", async () => {
    expect(await screenSpeech(TWILIO_DEMO_USER, "   ")).toBe("");
  });
});
