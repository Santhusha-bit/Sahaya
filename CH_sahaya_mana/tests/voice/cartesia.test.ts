import { describe, expect, it, vi } from "vitest";
import { CARTESIA_DEFAULT_VOICE_ID, CARTESIA_VERSION, CartesiaClient, CartesiaError } from "@/integrations/cartesia";
import { MAX_AUDIO_BYTES, MAX_SPEAK_CHARS, checkAudioUpload, chunkForSpeech, prepareSpeechText } from "@/integrations/voicePolicy";

const KEY = "sk_car_TEST_SECRET_123456";

function mockFetch(response: Response | (() => never)) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (typeof response === "function") return response();
    return response;
  });
}

describe("Cartesia client", () => {
  it("sends TTS requests with the documented endpoint, headers and payload", async () => {
    const f = mockFetch(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const c = new CartesiaClient({ apiKey: KEY, fetch: f as unknown as typeof fetch });
    const out = await c.speak("Hello Margaret.");
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.audio.byteLength).toBe(3);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ "X-API-Key": KEY, "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json" });
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({
      model_id: "sonic-3.6",
      transcript: "Hello Margaret.",
      voice: CARTESIA_DEFAULT_VOICE_ID,
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      language: "en",
      generation_config: { speed: 0.85 },
    });
  });

  it("uses a configured voice id", async () => {
    const f = mockFetch(new Response(new Uint8Array([1]), { status: 200 }));
    await new CartesiaClient({ apiKey: KEY, voiceId: "voice-xyz", fetch: f as unknown as typeof fetch }).speak("Hi.");
    expect(JSON.parse(f.mock.calls[0][1]!.body as string).voice).toBe("voice-xyz");
  });

  it("sends batch STT as multipart with ink-whisper and returns the transcript", async () => {
    const f = mockFetch(Response.json({ type: "transcript", text: " Hello there. ", duration: 1.4, language: "en" }));
    const c = new CartesiaClient({ apiKey: KEY, fetch: f as unknown as typeof fetch });
    const out = await c.transcribe(new Blob([new Uint8Array([1, 2])], { type: "audio/webm" }), { filename: "recording.webm" });
    expect(out).toEqual({ text: "Hello there.", durationSeconds: 1.4, language: "en" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/stt");
    expect(init!.headers).toMatchObject({ "X-API-Key": KEY, "Cartesia-Version": CARTESIA_VERSION });
    const form = init!.body as FormData;
    expect(form.get("model")).toBe("ink-whisper");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("recording.webm");
  });

  it.each([
    [401, "auth", "Cartesia rejected the API key"],
    [403, "auth", "Cartesia rejected the API key"],
    [429, "rate_limited", "rate limited"],
    [400, "bad_request", "couldn't process"],
    [500, "unavailable", "temporarily unavailable"],
  ] as const)("maps HTTP %i to %s without leaking the key", async (status, kind, message) => {
    const f = mockFetch(Response.json({ error_code: "x_code", message: `bad key ${KEY}` }, { status }));
    const c = new CartesiaClient({ apiKey: KEY, fetch: f as unknown as typeof fetch });
    const err = await c.speak("Hi.").catch((e) => e);
    expect(err).toBeInstanceOf(CartesiaError);
    expect(err).toMatchObject({ kind, status, errorCode: "x_code" });
    expect(err.message).toMatch(message);
    expect(JSON.stringify(err) + err.message + String(err.stack)).not.toContain(KEY);
  });

  it("maps network failures and malformed responses", async () => {
    const down = new CartesiaClient({ apiKey: KEY, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(down.speak("Hi.")).rejects.toMatchObject({ kind: "network" });
    const weird = new CartesiaClient({ apiKey: KEY, fetch: mockFetch(Response.json({ nope: true })) as unknown as typeof fetch });
    await expect(weird.transcribe(new Blob([new Uint8Array([1])]), { filename: "a.webm" })).rejects.toMatchObject({ kind: "invalid_response" });
    const empty = new CartesiaClient({ apiKey: KEY, fetch: mockFetch(new Response(new Uint8Array([]), { status: 200 })) as unknown as typeof fetch });
    await expect(empty.speak("Hi.")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("refuses to construct without a key", () => {
    expect(() => new CartesiaClient({ apiKey: "  " })).toThrow();
  });
});

describe("voice request policy", () => {
  it("accepts recorder formats from Chrome and Safari and rejects others", () => {
    expect(checkAudioUpload({ size: 10, type: "audio/webm;codecs=opus" })).toMatchObject({ ok: true, extension: "webm" });
    expect(checkAudioUpload({ size: 10, type: "audio/mp4" })).toMatchObject({ ok: true, extension: "mp4" });
    expect(checkAudioUpload({ size: 10, type: "audio/ogg;codecs=opus" })).toMatchObject({ ok: true, extension: "ogg" });
    expect(checkAudioUpload({ size: 10, type: "audio/mpeg" })).toMatchObject({ ok: true, extension: "mp3" });
    expect(checkAudioUpload({ size: 10, type: "image/png" })).toMatchObject({ ok: false, status: 415 });
    expect(checkAudioUpload({ size: 10, type: "" })).toMatchObject({ ok: false, status: 415 });
  });
  it("rejects empty, missing and oversized audio", () => {
    expect(checkAudioUpload(null)).toMatchObject({ ok: false, code: "NO_AUDIO" });
    expect(checkAudioUpload({ size: 0, type: "audio/webm" })).toMatchObject({ ok: false, code: "EMPTY_AUDIO" });
    expect(checkAudioUpload({ size: MAX_AUDIO_BYTES + 1, type: "audio/webm" })).toMatchObject({ ok: false, status: 413 });
  });
  it("prepares plain text and enforces the length cap", () => {
    expect(prepareSpeechText("**Hello** <b>Margaret</b>\n\n# Time for pills")).toEqual({ ok: true, text: "Hello Margaret Time for pills" });
    expect(prepareSpeechText("   ")).toMatchObject({ ok: false, code: "NO_TEXT" });
    expect(prepareSpeechText(42)).toMatchObject({ ok: false, code: "NO_TEXT" });
    expect(prepareSpeechText("a".repeat(MAX_SPEAK_CHARS + 1))).toMatchObject({ ok: false, status: 413 });
  });
  it("chunks long replies at sentence boundaries under the cap", () => {
    const text = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i + 1}.`).join(" ");
    const chunks = chunkForSpeech(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= MAX_SPEAK_CHARS)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });
});
