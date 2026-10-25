import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARTESIA_VERSION,
  createSttSession,
  sttUrl,
  synthesizeSpeech,
  transcribePcm,
} from "@/integrations/cartesia";
import { POST as sttTokenRoute } from "@/app/api/voice/stt-token/route";

const saved = { key: process.env.CARTESIA_API_KEY, caller: process.env.CARTESIA_CALLER_VOICE_ID };

function restore() {
  if (saved.key === undefined) delete process.env.CARTESIA_API_KEY;
  else process.env.CARTESIA_API_KEY = saved.key;
  if (saved.caller === undefined) delete process.env.CARTESIA_CALLER_VOICE_ID;
  else process.env.CARTESIA_CALLER_VOICE_ID = saved.caller;
}

describe("Cartesia sandbox (no key)", () => {
  beforeEach(() => delete process.env.CARTESIA_API_KEY);
  afterEach(restore);

  it("never calls Cartesia and reports null so the browser falls back", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await synthesizeSpeech("hello")).toBeNull();
    expect(await createSttSession()).toBeNull();
    expect(await transcribePcm(new Uint8Array(3200))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("stt-token route answers 204 so the client uses browser captions", async () => {
    const res = await sttTokenRoute();
    expect(res.status).toBe(204);
  });
});

describe("Cartesia live (mocked HTTP)", () => {
  beforeEach(() => {
    process.env.CARTESIA_API_KEY = "sk_car_test";
    delete process.env.CARTESIA_CALLER_VOICE_ID;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restore();
  });

  it("mints a short-lived STT-only token and builds the ink-whisper URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ token: "tok_abc" }), { status: 200 }));
    const session = await createSttSession(99999);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cartesia.ai/access-token");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_car_test");
    expect(headers["Cartesia-Version"]).toBe(CARTESIA_VERSION);
    const body = JSON.parse(String(init.body));
    expect(body.grants).toEqual({ stt: true });
    expect(body.expires_in).toBe(3600);

    expect(session?.token).toBe("tok_abc");
    const u = new URL(session!.url);
    expect(u.origin + u.pathname).toBe("wss://api.cartesia.ai/stt/websocket");
    expect(u.searchParams.get("model")).toBe("ink-whisper");
    expect(u.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(u.searchParams.get("sample_rate")).toBe("16000");
    expect(u.searchParams.get("access_token")).toBe("tok_abc");
    expect(session!.url).not.toContain("sk_car_test");
  });

  it("returns null (not a throw) when Cartesia rejects the token request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    expect(await createSttSession()).toBeNull();
  });

  it("voices the demo scam caller with its own persona and raw PCM for STT", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const out = await synthesizeSpeech("Grandma, it's Jake", undefined, { persona: "scam-caller", format: "pcm16k" });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.model_id).toBe("sonic-3");
    expect(body.voice.id).toBe("1463a4e1-56a1-4b41-b257-728d56e93605");
    expect(body.output_format).toEqual({ container: "raw", encoding: "pcm_s16le", sample_rate: 16000 });
    expect(body.generation_config.emotion).toBe("scared");
    expect(out?.contentType).toBe("audio/pcm");
    expect(out?.audio.byteLength).toBe(4);
  });

  it("keeps the default MP3 output for Guardian's voice", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Uint8Array([9]), { status: 200 }));
    const out = await synthesizeSpeech("Hang up and call Sarah.", undefined, { persona: "guardian" });
    const body = JSON.parse(String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.output_format.container).toBe("mp3");
    expect(body.generation_config.emotion).toBe("calm");
    expect(out?.contentType).toBe("audio/mpeg");
  });

  it("sttUrl never carries anything but the token", () => {
    const u = new URL(sttUrl("t1", 8000));
    expect(u.searchParams.get("sample_rate")).toBe("8000");
    expect(u.searchParams.get("cartesia_version")).toBe(CARTESIA_VERSION);
    expect([...u.searchParams.keys()].sort()).toEqual(
      ["access_token", "cartesia_version", "encoding", "language", "model", "sample_rate"].sort(),
    );
  });
});
