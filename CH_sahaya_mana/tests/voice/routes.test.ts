import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnResult } from "@/agents/base/BaseAgent";
import { CartesiaClient } from "@/integrations/cartesia";
import { handleSpeak, handleTranscribe, type VoiceDeps } from "@/lib/voice/handlers";
import { voiceStatus } from "@/lib/voice/status";
import { MAX_AUDIO_BYTES } from "@/integrations/voicePolicy";
import { userCtx } from "../helpers";

const KEY = "sk_car_ROUTE_SECRET_987";

function deps(over: Partial<VoiceDeps> & { fetch?: typeof fetch } = {}) {
  const logs: unknown[] = [];
  const results: Array<{ ok: boolean; kind?: string }> = [];
  const voiceInputs: unknown[] = [];
  const client = over.fetch ? new CartesiaClient({ apiKey: KEY, fetch: over.fetch }) : null;
  const d: VoiceDeps = {
    client: () => client,
    recordResult: (ok, err) => results.push({ ok, kind: err?.kind }),
    session: async () => userCtx,
    agent: async () => ({
      async processVoiceInput(_ctx, input) {
        voiceInputs.push(input);
        return { reply: "Okay.", status: "ok", approvals: [], toolCalls: [] } satisfies TurnResult;
      },
    }),
    errorResponse: (err) => Response.json({ error: String(err) }, { status: 500 }),
    log: (event, data) => logs.push({ event, ...data }),
    rateLimit: () => ({ allowed: true, retryAfterSecs: 0 }),
    recordStream: () => {},
    ...over,
  };
  return { d, logs, results, voiceInputs };
}

const stt = (text: string, duration = 2) => (async () => Response.json({ type: "transcript", text, duration })) as unknown as typeof fetch;
const tts = (async () => new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
const reject401 = (async () => Response.json({ error_code: "unauthorized" }, { status: 401 })) as unknown as typeof fetch;

function upload(fields: Record<string, Blob | string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request("http://localhost/api/voice/transcribe", { method: "POST", body: form });
}
const audio = (type = "audio/webm", size = 100) => new Blob([new Uint8Array(size)], { type });
const speakReq = (body: unknown) => new Request("http://localhost/api/voice/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => vi.restoreAllMocks());

describe("POST /api/voice/transcribe", () => {
  it("transcribes and hands the transcript to the agent's processVoiceInput", async () => {
    const { d, voiceInputs, logs } = deps({ fetch: stt("I took my morning pill") });
    const res = await handleTranscribe(upload({ audio: audio(), agent: "care" }), d);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ transcript: "I took my morning pill", provider: "cartesia", turn: { reply: "Okay." } });
    expect(voiceInputs).toEqual([{ transcript: "I took my morning pill" }]);
    expect(JSON.stringify(logs)).not.toContain("morning pill");
  });

  it("can return the transcript only", async () => {
    const { d, voiceInputs } = deps({ fetch: stt("Hello") });
    const res = await handleTranscribe(upload({ audio: audio("audio/mp4"), target: "transcript" }), d);
    expect(await res.json()).toEqual({ transcript: "Hello", provider: "cartesia" });
    expect(voiceInputs).toHaveLength(0);
  });

  it.each([
    ["missing audio", () => upload({ agent: "care" }), 400, "NO_AUDIO"],
    ["empty audio", () => upload({ audio: audio("audio/webm", 0), agent: "care" }), 400, "EMPTY_AUDIO"],
    ["wrong type", () => upload({ audio: audio("text/plain"), agent: "care" }), 415, "UNSUPPORTED_AUDIO"],
    ["too large", () => upload({ audio: audio("audio/webm", MAX_AUDIO_BYTES + 10), agent: "care" }), 413, "AUDIO_TOO_LARGE"],
  ])("rejects %s", async (_n, make, status, code) => {
    const { d } = deps({ fetch: stt("x") });
    const res = await handleTranscribe(make(), d);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it("rejects an unknown agent, silence, and over-long recordings", async () => {
    expect((await handleTranscribe(upload({ audio: audio(), agent: "nobody" }), deps({ fetch: stt("x") }).d)).status).toBe(404);
    const silent = await handleTranscribe(upload({ audio: audio(), agent: "care" }), deps({ fetch: stt("   ") }).d);
    expect(silent.status).toBe(422);
    const long = await handleTranscribe(upload({ audio: audio(), agent: "care" }), deps({ fetch: stt("words", 120) }).d);
    expect(long.status).toBe(413);
  });

  it("returns a browser fallback when Cartesia isn't configured", async () => {
    const res = await handleTranscribe(upload({ audio: audio(), agent: "care" }), deps().d);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "VOICE_UNAVAILABLE", fallback: "browser" });
  });

  it("surfaces 'Cartesia rejected the key' and records it, without leaking the key", async () => {
    const info = vi.spyOn(console, "info");
    const error = vi.spyOn(console, "error");
    const { d, results, logs } = deps({ fetch: reject401 });
    const res = await handleTranscribe(upload({ audio: audio(), agent: "care" }), d);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "CARTESIA_AUTH", fallback: "browser", error: "Cartesia rejected the API key" });
    expect(results).toEqual([{ ok: false, kind: "auth" }]);
    const everything = text + JSON.stringify(logs) + JSON.stringify(info.mock.calls) + JSON.stringify(error.mock.calls);
    expect(everything).not.toContain(KEY);
  });
});

describe("POST /api/voice/speak", () => {
  it("returns MP3 bytes for plain text", async () => {
    const { d, logs, results } = deps({ fetch: tts });
    const res = await handleSpeak(speakReq({ text: "Hello Margaret, this is a voice test." }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.arrayBuffer()).byteLength).toBe(3);
    expect(results).toEqual([{ ok: true, kind: undefined }]);
    expect(JSON.stringify(logs)).not.toContain("Margaret");
  });

  it("validates input", async () => {
    const { d } = deps({ fetch: tts });
    expect((await handleSpeak(speakReq({ text: "" }), d)).status).toBe(400);
    expect((await handleSpeak(speakReq({ text: "x".repeat(1001) }), d)).status).toBe(413);
    expect((await handleSpeak(new Request("http://localhost/api/voice/speak", { method: "POST", body: "not json" }), d)).status).toBe(400);
  });

  it("falls back honestly when unconfigured or rejected", async () => {
    expect(await (await handleSpeak(speakReq({ text: "Hi." }), deps().d)).json()).toMatchObject({ code: "VOICE_UNAVAILABLE", fallback: "browser" });
    const res = await handleSpeak(speakReq({ text: "Hi." }), deps({ fetch: reject401 }).d);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ code: "CARTESIA_AUTH" });
    expect(body).not.toContain(KEY);
  });
});

describe("voice status labelling", () => {
  const none = { lastOkAt: null, lastAuthFailureAt: null, lastFailureKind: null };
  it("labels streaming as unavailable without Cartesia, unverified until a stream works, live after", () => {
    expect(voiceStatus(false, none).streaming).toEqual({ mode: "unavailable", label: "Browser speech (not Cartesia)" });
    expect(voiceStatus(true, none).streaming.mode).toBe("unverified");
    expect(voiceStatus(true, { ...none, lastStreamOkAt: 5 }).streaming).toEqual({ mode: "live", label: "Cartesia streaming (live)" });
    expect(voiceStatus(true, { ...none, lastStreamOkAt: 5, lastStreamFailureAt: 6 }).streaming.mode).toBe("unavailable");
  });
  it("is browser speech, clearly labelled, without a key", () => {
    expect(voiceStatus(false, none)).toMatchObject({ provider: "browser", mode: "unavailable", label: "Browser speech (not Cartesia)" });
  });
  it("is live once wired with a key, verified after a successful call", () => {
    expect(voiceStatus(true, none)).toMatchObject({ provider: "cartesia", mode: "live", verified: false });
    expect(voiceStatus(true, { ...none, lastOkAt: 5 })).toMatchObject({ provider: "cartesia", verified: true });
  });
  it("drops to browser speech and says the key was rejected after a 401", () => {
    expect(voiceStatus(true, { ...none, lastOkAt: 1, lastAuthFailureAt: 2 })).toMatchObject({ provider: "browser", rejected: true, detail: expect.stringMatching(/Cartesia rejected the key/) });
    expect(voiceStatus(true, { ...none, lastOkAt: 3, lastAuthFailureAt: 2 })).toMatchObject({ provider: "cartesia", rejected: false });
  });
});
