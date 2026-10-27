import { describe, expect, it, vi } from "vitest";
import { CARTESIA_DEFAULT_VOICE_ID, CartesiaClient, streamConfig, sttStreamUrl, ttsStreamRequest, ttsStreamUrl } from "@/integrations/cartesia";
import { handleStreamHealth, handleToken, type VoiceDeps } from "@/lib/voice/handlers";
import { RateLimiter } from "@/lib/voice/rateLimit";
import { DEFAULT_TURN_CONFIG, initialTurnModel, isMeaningful, turnReducer, type TurnEvent, type TurnModel } from "@/lib/voice/turnMachine";
import { userCtx } from "../helpers";

const KEY = "sk_car_STREAM_SECRET_555";

describe("Cartesia streaming building blocks", () => {
  it("mints an access token with STT+TTS grants and a short expiry", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => Response.json({ token: "tok_short_lived" }));
    const c = new CartesiaClient({ apiKey: KEY, fetch: f as unknown as typeof fetch });
    expect(await c.accessToken({ stt: true, tts: true })).toEqual({ token: "tok_short_lived", expiresInSecs: 120 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.cartesia.ai/access-token");
    expect(JSON.parse(init!.body as string)).toEqual({ grants: { stt: true, tts: true }, expires_in: 120 });
    expect(init!.headers).toMatchObject({ "X-API-Key": KEY });
  });

  it("refuses a 'token' that is the API key itself or missing", async () => {
    const echo = new CartesiaClient({ apiKey: KEY, fetch: (async () => Response.json({ token: KEY })) as unknown as typeof fetch });
    await expect(echo.accessToken({ stt: true })).rejects.toMatchObject({ kind: "invalid_response" });
    const none = new CartesiaClient({ apiKey: KEY, fetch: (async () => Response.json({})) as unknown as typeof fetch });
    await expect(none.accessToken({ stt: true })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("builds stream URLs with the access token and documented parameters, never a key", () => {
    const cfg = streamConfig(CARTESIA_DEFAULT_VOICE_ID);
    const stt = new URL(sttStreamUrl("tok_abc", cfg));
    expect(stt.origin + stt.pathname).toBe("wss://api.cartesia.ai/stt/websocket");
    expect(Object.fromEntries(stt.searchParams)).toMatchObject({
      model: "ink-whisper",
      encoding: "pcm_s16le",
      sample_rate: "16000",
      cartesia_version: "2026-08-14",
      language: "en",
      max_silence_duration_secs: "0.8",
      access_token: "tok_abc",
    });
    const tts = new URL(ttsStreamUrl("tok_abc", cfg));
    expect(tts.pathname).toBe("/tts/websocket");
    expect(tts.searchParams.get("access_token")).toBe("tok_abc");
    expect(ttsStreamRequest(cfg, "ctx1", "Hello.", false)).toMatchObject({
      model_id: "sonic-3.6",
      voice: "6c756032-11c3-4be8-a120-74f9673fb700",
      context_id: "ctx1",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      continue: false,
    });
  });
});

function tokenDeps(over: Partial<VoiceDeps & { voiceId(): string }> & { fetch?: typeof fetch } = {}) {
  const logs: unknown[] = [];
  const limiter = new RateLimiter({ token: { limit: 2, windowMs: 60_000 }, health: { limit: 2, windowMs: 60_000 } });
  const reports: Array<[boolean, string]> = [];
  const client = over.fetch ? new CartesiaClient({ apiKey: KEY, fetch: over.fetch }) : null;
  const d: VoiceDeps & { voiceId(): string } = {
    client: () => client,
    recordResult: () => {},
    session: async () => userCtx,
    agent: async () => {
      throw new Error("unused");
    },
    errorResponse: () => Response.json({ error: "denied" }, { status: 403 }),
    log: (event, data) => logs.push({ event, ...data }),
    rateLimit: (k, b) => limiter.take(k, b),
    recordStream: (ok, kind) => reports.push([ok, kind]),
    voiceId: () => CARTESIA_DEFAULT_VOICE_ID,
    ...over,
  };
  return { d, logs, reports };
}
const post = (body?: unknown) => new Request("http://localhost/api/voice/x", { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("POST /api/voice/token", () => {
  it("returns a short-lived token and browser-safe config, never the key", async () => {
    const info = vi.spyOn(console, "info");
    const { d, logs } = tokenDeps({ fetch: (async () => Response.json({ token: "tok_ok" })) as unknown as typeof fetch });
    const res = await handleToken(post(), d);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ token: "tok_ok", expiresInSecs: 120, config: { voiceId: CARTESIA_DEFAULT_VOICE_ID, inputSampleRate: 16000 } });
    expect(text + JSON.stringify(logs) + JSON.stringify(info.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain("tok_ok");
  });

  it("is rate limited per session", async () => {
    const { d } = tokenDeps({ fetch: (async () => Response.json({ token: "t" })) as unknown as typeof fetch });
    expect((await handleToken(post(), d)).status).toBe(200);
    expect((await handleToken(post(), d)).status).toBe(200);
    const third = await handleToken(post(), d);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("requires a session", async () => {
    const { d } = tokenDeps({ fetch: (async () => Response.json({ token: "t" })) as unknown as typeof fetch, session: async () => { throw new Error("no session"); } });
    expect((await handleToken(post(), d)).status).toBe(403);
  });

  it("reports a rejected key and an unconfigured server with a browser fallback", async () => {
    const rejected = await handleToken(post(), tokenDeps({ fetch: (async () => Response.json({}, { status: 401 })) as unknown as typeof fetch }).d);
    const body = await rejected.text();
    expect(JSON.parse(body)).toMatchObject({ code: "CARTESIA_AUTH", fallback: "browser" });
    expect(body).not.toContain(KEY);
    expect(await (await handleToken(post(), tokenDeps().d)).json()).toMatchObject({ code: "VOICE_UNAVAILABLE", fallback: "browser" });
  });
});

describe("POST /api/voice/stream-health", () => {
  it("accepts only known outcome kinds, with no content, and is rate limited", async () => {
    const { d, reports } = tokenDeps();
    expect((await handleStreamHealth(post({ ok: true, kind: "stt_transcript" }), d)).status).toBe(200);
    expect((await handleStreamHealth(post({ ok: true, kind: "transcript: hello" }), d)).status).toBe(400);
    expect(reports).toEqual([[true, "stt_transcript"]]);
    expect((await handleStreamHealth(post({ ok: false, kind: "network" }), d)).status).toBe(429);
  });
});

describe("rate limiter", () => {
  it("uses a sliding window per session and bucket", () => {
    let now = 0;
    const rl = new RateLimiter({ speak: { limit: 2, windowMs: 1000 } }, () => now);
    expect(rl.take("a", "speak").allowed).toBe(true);
    expect(rl.take("a", "speak").allowed).toBe(true);
    expect(rl.take("a", "speak")).toEqual({ allowed: false, retryAfterSecs: 1 });
    expect(rl.take("b", "speak").allowed).toBe(true);
    now = 1001;
    expect(rl.take("a", "speak").allowed).toBe(true);
  });
});

describe("turn-taking state machine", () => {
  const cfg = DEFAULT_TURN_CONFIG;
  function run(events: TurnEvent[], start: TurnModel = initialTurnModel()) {
    let m = start;
    const effects: string[] = [];
    for (const e of events) {
      const r = turnReducer(m, e, cfg);
      m = r.model;
      effects.push(...r.effects.map((f) => (f.type === "submit" || f.type === "speak" ? `${f.type}:${f.text}` : f.type)));
    }
    return { m, effects };
  }
  const started = (t = 0) => run([{ type: "start", now: t }, { type: "connected", now: t }]).m;

  it("filters noise: empty and filler-only results are not words", () => {
    expect(isMeaningful("")).toBe(false);
    expect(isMeaningful(" um, hmm... ")).toBe(false);
    expect(isMeaningful("yes")).toBe(true);
    expect(isMeaningful("ok")).toBe(true);
    expect(isMeaningful("2")).toBe(true);
  });

  it("shows partials, waits for a final plus a pause, then submits once", () => {
    const { m, effects } = run(
      [
        { type: "partial", text: "I took my", now: 100 },
        { type: "tick", now: 400 },
        { type: "final", text: "I took my morning pill.", now: 900 },
        { type: "tick", now: 900 + cfg.turnEndMs - 1 },
        { type: "tick", now: 900 + cfg.turnEndMs },
        { type: "tick", now: 900 + cfg.turnEndMs + 500 },
      ],
      started(),
    );
    expect(effects).toEqual(["submit:I took my morning pill."]);
    expect(m.state).toBe("thinking");
  });

  it("keeps the turn open while she is still speaking (mic level) and joins multiple finals", () => {
    const { effects } = run(
      [
        { type: "final", text: "I need milk", now: 0 },
        { type: "level", rms: 0.2, now: 500 },
        { type: "tick", now: 900 },
        { type: "final", text: " and bread.", now: 1300 },
        { type: "tick", now: 1300 + cfg.turnEndMs },
      ],
      started(),
    );
    expect(effects).toEqual(["submit:I need milk and bread."]);
  });

  it("asks the recognizer to finalize a dangling partial after quiet", () => {
    const { effects, m } = run([{ type: "partial", text: "what's for dinner", now: 0 }, { type: "tick", now: cfg.finalizeAfterMs }, { type: "tick", now: cfg.finalizeAfterMs + 200 }], started());
    expect(effects).toEqual(["finalize"]);
    expect(m.finalizeRequested).toBe(true);
  });

  it("ignores empty and noise-only transcripts", () => {
    const { effects, m } = run([{ type: "final", text: "  ", now: 0 }, { type: "final", text: "um", now: 10 }, { type: "tick", now: 5000 }], started());
    expect(effects).toEqual([]);
    expect(m.turnText).toBe("");
  });

  it("speaks the reply, then listens again", () => {
    const thinking = run([{ type: "final", text: "Hello", now: 0 }, { type: "tick", now: 1000 }], started()).m;
    const { m, effects } = run([{ type: "reply", text: "Hi Margaret.", now: 2000 }, { type: "speakingDone", now: 4000 }], thinking);
    expect(effects).toEqual(["speak:Hi Margaret."]);
    expect(m.state).toBe("listening");
  });

  it("barge-in: her words during playback stop audio at once and start a new turn", () => {
    const thinking = run([{ type: "final", text: "Hello", now: 0 }, { type: "tick", now: 1000 }], started()).m;
    const speaking = run([{ type: "reply", text: "Long answer…", now: 2000 }], thinking).m;
    const { m, effects } = run([{ type: "partial", text: "wait stop", now: 2500 }, { type: "final", text: "Wait, stop.", now: 3000 }, { type: "tick", now: 3000 + cfg.turnEndMs }], speaking);
    expect(effects).toEqual(["stopSpeaking", "submit:Wait, stop."]);
    expect(m.state).toBe("thinking");
  });

  it("mic level or filler alone never interrupts Care (speaker echo safety)", () => {
    const thinking = run([{ type: "final", text: "Hello", now: 0 }, { type: "tick", now: 1000 }], started()).m;
    const speaking = run([{ type: "reply", text: "Answer.", now: 2000 }], thinking).m;
    const { m, effects } = run([{ type: "level", rms: 0.9, now: 2100 }, { type: "partial", text: "mm", now: 2200 }], speaking);
    expect(effects).toEqual([]);
    expect(m.state).toBe("speaking");
  });

  it("doesn't submit while Care is thinking; holds what she says for the next turn", () => {
    const thinking = run([{ type: "final", text: "Hello", now: 0 }, { type: "tick", now: 1000 }], started()).m;
    const r = run([{ type: "final", text: "Also eggs.", now: 1200 }, { type: "tick", now: 5000 }], thinking);
    expect(r.effects).toEqual([]);
    const after = run([{ type: "reply", text: "", now: 6000 }, { type: "tick", now: 6000 + cfg.turnEndMs }], r.m);
    expect(after.effects).toEqual(["submit:Also eggs."]);
  });

  it("ends after the silence timeout with a notice", () => {
    const { m, effects } = run([{ type: "tick", now: cfg.silenceTimeoutMs - 1 }, { type: "tick", now: cfg.silenceTimeoutMs }], started());
    expect(effects).toEqual(["notice", "close"]);
    expect(m).toMatchObject({ state: "ended", endReason: "silence" });
  });

  it("muting ignores speech; unmuting resumes", () => {
    const muted = run([{ type: "mute", muted: true, now: 0 }, { type: "final", text: "secret words", now: 10 }, { type: "tick", now: 5000 }], started());
    expect(muted.effects).toEqual([]);
    expect(muted.m.turnText).toBe("");
  });

  it("reconnects once after a drop, then gives up with an error", () => {
    const first = run([{ type: "disconnected", now: 10 }], started());
    expect(first.effects).toEqual(["reconnect"]);
    expect(first.m.state).toBe("connecting");
    const back = run([{ type: "connected", now: 20 }], first.m);
    expect(back.m.state).toBe("listening");
    const second = run([{ type: "disconnected", now: 30, error: "Network lost." }], back.m);
    expect(second.effects).toEqual(["notice", "close"]);
    expect(second.m).toMatchObject({ state: "error", endReason: "error" });
  });

  it("End conversation stops playback and closes", () => {
    const thinking = run([{ type: "final", text: "Hello", now: 0 }, { type: "tick", now: 1000 }], started()).m;
    const speaking = run([{ type: "reply", text: "Answer.", now: 2000 }], thinking).m;
    expect(run([{ type: "end", now: 2100 }], speaking).effects).toEqual(["stopSpeaking", "close"]);
  });
});
