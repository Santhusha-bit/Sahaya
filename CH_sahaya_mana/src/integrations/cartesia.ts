/**
 * Cartesia speech client (REST). Pure and dependency-injected: it never reads the environment, so the
 * API key is passed in by server-only code (src/lib/server/voice.ts) and never reaches the browser.
 *
 * Checked against docs.cartesia.ai on 2026-10-24:
 *  - Batch STT:  POST https://api.cartesia.ai/stt  (multipart: file, model=ink-whisper, language)
 *                accepted containers: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
 *  - TTS bytes:  POST https://api.cartesia.ai/tts/bytes  (model_id sonic-3.6, voice id, output_format, generation_config)
 *  - Headers:    Cartesia-Version: 2026-08-14; server-side auth via X-API-Key (Authorization: Bearer also accepted)
 *  - Errors:     structured JSON { error_code, title, message, request_id } for versions ≥ 2026-03-01
 *  - Streaming (checked 2026-10-24):
 *      access tokens  POST /access-token { grants: { stt, tts }, expires_in ≤ 3600 } → { token }; browsers pass it as
 *                     ?access_token= on WebSockets, so the API key never leaves the server
 *      STT            wss://api.cartesia.ai/stt/websocket?model=ink-whisper&encoding=pcm_s16le&sample_rate=16000
 *                     &cartesia_version=…&language=en&min_volume=…&max_silence_duration_secs=… ; binary ~100 ms
 *                     chunks; text "finalize" / "close"; replies { type: transcript, is_final, text (delta) },
 *                     flush_done, done, error
 *      TTS            wss://api.cartesia.ai/tts/websocket?cartesia_version=… ; JSON { model_id, transcript, voice,
 *                     language, context_id, output_format{raw,pcm_s16le,rate}, continue } ; { context_id, cancel }
 *                     replies { type: chunk, data(base64) } / done / error
 */

export const CARTESIA_BASE_URL = "https://api.cartesia.ai";
export const CARTESIA_VERSION = "2026-08-14";
export const CARTESIA_STT_MODEL = "ink-whisper";
export const CARTESIA_TTS_MODEL = "sonic-3.6";
/** Default voice chosen by the project owner (a voice id is not a secret). Override with CARTESIA_VOICE_ID. */
export const CARTESIA_DEFAULT_VOICE_ID = "6c756032-11c3-4be8-a120-74f9673fb700";
/** Slightly slower than default for older listeners (Cartesia accepts 0.6–1.5; treated as guidance). */
export const CARTESIA_DEFAULT_SPEED = 0.85;
export const CARTESIA_WS_BASE = "wss://api.cartesia.ai";
export const STREAM_SAMPLE_RATE_IN = 16000;
export const STREAM_SAMPLE_RATE_OUT = 24000;
/** Silence before ink-whisper finalizes an utterance. Tuned a little long for slower, older-adult speech. */
export const STREAM_MAX_SILENCE_SECS = 0.8;
export const STREAM_MIN_VOLUME = 0.12;
export const ACCESS_TOKEN_TTL_SECS = 120;

/** Browser-safe streaming parameters: everything except a credential. */
export interface StreamConfig {
  sttModel: string;
  ttsModel: string;
  voiceId: string;
  speed: number;
  cartesiaVersion: string;
  inputSampleRate: number;
  outputSampleRate: number;
  maxSilenceSecs: number;
  minVolume: number;
}

export function streamConfig(voiceId: string, speed = CARTESIA_DEFAULT_SPEED): StreamConfig {
  return {
    sttModel: CARTESIA_STT_MODEL,
    ttsModel: CARTESIA_TTS_MODEL,
    voiceId,
    speed,
    cartesiaVersion: CARTESIA_VERSION,
    inputSampleRate: STREAM_SAMPLE_RATE_IN,
    outputSampleRate: STREAM_SAMPLE_RATE_OUT,
    maxSilenceSecs: STREAM_MAX_SILENCE_SECS,
    minVolume: STREAM_MIN_VOLUME,
  };
}

/** STT WebSocket URL authenticated with a short-lived access token (never the API key). */
export function sttStreamUrl(token: string, c: StreamConfig): string {
  const q = new URLSearchParams({
    model: c.sttModel,
    encoding: "pcm_s16le",
    sample_rate: String(c.inputSampleRate),
    cartesia_version: c.cartesiaVersion,
    language: "en",
    min_volume: String(c.minVolume),
    max_silence_duration_secs: String(c.maxSilenceSecs),
    access_token: token,
  });
  return `${CARTESIA_WS_BASE}/stt/websocket?${q}`;
}

export function ttsStreamUrl(token: string, c: StreamConfig): string {
  const q = new URLSearchParams({ cartesia_version: c.cartesiaVersion, access_token: token });
  return `${CARTESIA_WS_BASE}/tts/websocket?${q}`;
}

/** One TTS generation request for the WebSocket (raw 16-bit PCM for gapless Web Audio playback). */
export function ttsStreamRequest(c: StreamConfig, contextId: string, transcript: string, more: boolean) {
  return {
    model_id: c.ttsModel,
    transcript,
    voice: c.voiceId,
    language: "en",
    context_id: contextId,
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: c.outputSampleRate },
    generation_config: { speed: c.speed, volume: 1 },
    continue: more,
  };
}

export type CartesiaErrorKind = "auth" | "rate_limited" | "bad_request" | "unavailable" | "network" | "invalid_response";

/** Errors carry only the kind, HTTP status and Cartesia's error code — never the key, audio or text. */
export class CartesiaError extends Error {
  constructor(
    readonly kind: CartesiaErrorKind,
    readonly status: number | null,
    readonly errorCode?: string,
  ) {
    super(CartesiaError.describe(kind));
    this.name = "CartesiaError";
  }

  static describe(kind: CartesiaErrorKind) {
    switch (kind) {
      case "auth":
        return "Cartesia rejected the API key";
      case "rate_limited":
        return "Cartesia is busy right now (rate limited); try again shortly";
      case "bad_request":
        return "Cartesia couldn't process that audio or text";
      case "unavailable":
        return "Cartesia is temporarily unavailable";
      case "network":
        return "Couldn't reach Cartesia";
      case "invalid_response":
        return "Cartesia returned an unexpected response";
    }
  }
}

export interface CartesiaOptions {
  apiKey: string;
  voiceId?: string;
  speed?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface TranscriptionResult {
  text: string;
  durationSeconds: number | null;
  language: string | null;
}

export interface SpeechResult {
  audio: ArrayBuffer;
  contentType: string;
}

function kindForStatus(status: number): CartesiaErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

export class CartesiaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  readonly voiceId: string;
  readonly speed: number;

  constructor(private readonly opts: CartesiaOptions) {
    if (!opts.apiKey?.trim()) throw new Error("CartesiaClient needs an API key");
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? CARTESIA_BASE_URL;
    this.voiceId = opts.voiceId?.trim() || CARTESIA_DEFAULT_VOICE_ID;
    this.speed = opts.speed ?? CARTESIA_DEFAULT_SPEED;
  }

  private headers(extra: Record<string, string> = {}) {
    return { "X-API-Key": this.opts.apiKey, "Cartesia-Version": CARTESIA_VERSION, ...extra };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    } catch {
      throw new CartesiaError("network", null);
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error_code?: unknown };
        if (typeof body?.error_code === "string") code = body.error_code.slice(0, 60);
      } catch {
        // non-JSON error body; nothing to keep
      }
      throw new CartesiaError(kindForStatus(res.status), res.status, code);
    }
    return res;
  }

  /** Short-lived token the browser can use for Cartesia WebSockets. The API key itself is never returned. */
  async accessToken(grants: { stt?: boolean; tts?: boolean }, expiresInSecs = ACCESS_TOKEN_TTL_SECS): Promise<{ token: string; expiresInSecs: number }> {
    const ttl = Math.max(10, Math.min(3600, Math.round(expiresInSecs)));
    const res = await this.request("/access-token", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ grants: { stt: Boolean(grants.stt), tts: Boolean(grants.tts) }, expires_in: ttl }),
    });
    let body: { token?: unknown };
    try {
      body = await res.json();
    } catch {
      throw new CartesiaError("invalid_response", res.status);
    }
    if (typeof body.token !== "string" || !body.token || body.token === this.opts.apiKey) throw new CartesiaError("invalid_response", res.status);
    return { token: body.token, expiresInSecs: ttl };
  }

  /** Batch speech-to-text for one recorded clip. */
  async transcribe(audio: Blob, opts: { filename: string; language?: string }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", audio, opts.filename);
    form.append("model", CARTESIA_STT_MODEL);
    form.append("language", opts.language ?? "en");
    const res = await this.request("/stt", { method: "POST", headers: this.headers(), body: form });
    let body: { text?: unknown; duration?: unknown; language?: unknown };
    try {
      body = await res.json();
    } catch {
      throw new CartesiaError("invalid_response", res.status);
    }
    if (typeof body.text !== "string") throw new CartesiaError("invalid_response", res.status);
    return {
      text: body.text.trim(),
      durationSeconds: typeof body.duration === "number" ? body.duration : null,
      language: typeof body.language === "string" ? body.language : null,
    };
  }

  /** Text-to-speech as an MP3 (plays in every current browser, including Safari). */
  async speak(text: string, opts: { language?: string } = {}): Promise<SpeechResult> {
    const res = await this.request("/tts/bytes", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model_id: CARTESIA_TTS_MODEL,
        transcript: text,
        voice: this.voiceId,
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        language: opts.language ?? "en",
        generation_config: { speed: this.speed, volume: 1 },
      }),
    });
    const audio = await res.arrayBuffer();
    if (audio.byteLength === 0) throw new CartesiaError("invalid_response", res.status);
    const type = res.headers.get("content-type");
    return { audio, contentType: type && type.startsWith("audio/") ? type : "audio/mpeg" };
  }
}
