/**
 * Voice route logic, kept free of `server-only` so it can be tested with injected dependencies.
 * The route files in src/app/api/voice/* wire the real session, runtime and Cartesia client.
 *
 * Privacy: transcripts, audio and spoken text are never logged — only sizes, lengths and status.
 */
import type { TurnResult, VoiceInput } from "@/agents/base/BaseAgent";
import { isAgentId, type AgentContext, type AgentId } from "@/agents/base/types";
import { CartesiaError, streamConfig, type CartesiaClient } from "@/integrations/cartesia";
import { MAX_AUDIO_BYTES, MAX_REPORTED_SECONDS, checkAudioUpload, prepareSpeechText } from "@/integrations/voicePolicy";

export interface VoiceDeps {
  /** The configured Cartesia client, or null when CARTESIA_API_KEY isn't set. */
  client(): CartesiaClient | null;
  /** Health bookkeeping so the UI can say "Cartesia rejected the key" instead of claiming live. */
  recordResult(ok: boolean, err?: CartesiaError): void;
  session(): Promise<AgentContext>;
  agent(id: AgentId, ctx: AgentContext): Promise<{ processVoiceInput(ctx: AgentContext, input: VoiceInput): Promise<TurnResult> }>;
  errorResponse(err: unknown): Response;
  log(event: string, data: Record<string, number | string | boolean | null>): void;
  /** Per-session rate limiting (see src/lib/voice/rateLimit.ts). */
  rateLimit(sessionKey: string, bucket: "token" | "transcribe" | "speak" | "health"): { allowed: boolean; retryAfterSecs: number };
  /** Browser-reported streaming outcome (no content), so status reports streaming live only when it worked. */
  recordStream(ok: boolean, kind: string): void;
}

function limited(retryAfterSecs: number) {
  return Response.json(
    { error: "Too many voice requests. Please wait a moment.", code: "RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(retryAfterSecs), "Cache-Control": "no-store" } },
  );
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function unavailable() {
  return json(
    { error: "Cartesia voice isn't configured on the server.", code: "VOICE_UNAVAILABLE", fallback: "browser" },
    503,
  );
}

function cartesiaFailure(err: CartesiaError) {
  return json(
    { error: err.message, code: err.kind === "auth" ? "CARTESIA_AUTH" : "CARTESIA_FAILED", fallback: "browser" },
    err.kind === "rate_limited" ? 429 : err.kind === "bad_request" ? 422 : 502,
  );
}

/**
 * POST multipart: audio (File), agent (agent id), target ("agent" default | "transcript").
 * With target=agent, the transcript goes through the agent's existing processVoiceInput, so the same
 * conversation permissions, tool rules and approvals apply as for typed messages.
 */
export async function handleTranscribe(req: Request, deps: VoiceDeps): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES + 64 * 1024) {
    return json({ error: "Recordings can be up to 60 seconds.", code: "AUDIO_TOO_LARGE" }, 413);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected a multipart audio upload.", code: "BAD_REQUEST" }, 400);
  }
  const audio = form.get("audio");
  const file = audio instanceof Blob ? audio : null;
  const check = checkAudioUpload(file);
  if (!check.ok) return json({ error: check.message, code: check.code }, check.status);
  const target = form.get("target") === "transcript" ? "transcript" : "agent";
  const agentId = String(form.get("agent") ?? "");
  if (target === "agent" && !isAgentId(agentId)) return json({ error: "Unknown agent", code: "BAD_REQUEST" }, 404);

  const client = deps.client();
  if (!client) return unavailable();

  let ctx: AgentContext;
  try {
    ctx = await deps.session();
  } catch (err) {
    return deps.errorResponse(err);
  }

  const rl = deps.rateLimit(ctx.actor.id, "transcribe");
  if (!rl.allowed) return limited(rl.retryAfterSecs);

  const started = Date.now();
  let text: string;
  let duration: number | null;
  try {
    const res = await client.transcribe(file!, { filename: `recording.${check.extension}` });
    text = res.text;
    duration = res.durationSeconds;
    deps.recordResult(true);
  } catch (err) {
    if (err instanceof CartesiaError) {
      deps.recordResult(false, err);
      deps.log("transcribe_failed", { kind: err.kind, status: err.status, bytes: file!.size });
      return cartesiaFailure(err);
    }
    deps.log("transcribe_failed", { kind: "unexpected", status: null, bytes: file!.size });
    return json({ error: "Transcription failed.", code: "CARTESIA_FAILED", fallback: "browser" }, 502);
  }
  deps.log("transcribed", { bytes: file!.size, chars: text.length, seconds: duration, ms: Date.now() - started });
  if (duration !== null && duration > MAX_REPORTED_SECONDS) {
    return json({ error: "Recordings can be up to 60 seconds.", code: "AUDIO_TOO_LONG" }, 413);
  }
  if (!text) return json({ error: "I didn't hear any words. Please try again a little closer to the microphone.", code: "NO_SPEECH" }, 422);

  if (target === "transcript") return json({ transcript: text, provider: "cartesia" });
  try {
    const agent = await deps.agent(agentId as AgentId, ctx);
    const turn = await agent.processVoiceInput(ctx, { transcript: text });
    return json({ transcript: text, provider: "cartesia", turn });
  } catch (err) {
    return deps.errorResponse(err);
  }
}

/** POST JSON { text } → audio/mpeg from Cartesia. Plain text only, ≤ 1,000 characters. */
export async function handleSpeak(req: Request, deps: VoiceDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected JSON.", code: "BAD_REQUEST" }, 400);
  }
  const check = prepareSpeechText((body as { text?: unknown } | null)?.text);
  if (!check.ok) return json({ error: check.message, code: check.code }, check.status);
  const client = deps.client();
  if (!client) return unavailable();
  let ctx: AgentContext;
  try {
    ctx = await deps.session();
  } catch (err) {
    return deps.errorResponse(err);
  }
  const rl = deps.rateLimit(ctx.actor.id, "speak");
  if (!rl.allowed) return limited(rl.retryAfterSecs);
  const started = Date.now();
  try {
    const speech = await client.speak(check.text);
    deps.recordResult(true);
    deps.log("spoke", { chars: check.text.length, bytes: speech.audio.byteLength, ms: Date.now() - started });
    return new Response(speech.audio, {
      status: 200,
      headers: { "Content-Type": speech.contentType, "Cache-Control": "no-store", "X-Voice-Provider": "cartesia" },
    });
  } catch (err) {
    if (err instanceof CartesiaError) {
      deps.recordResult(false, err);
      deps.log("speak_failed", { kind: err.kind, status: err.status, chars: check.text.length });
      return cartesiaFailure(err);
    }
    deps.log("speak_failed", { kind: "unexpected", status: null, chars: check.text.length });
    return json({ error: "Speech failed.", code: "CARTESIA_FAILED", fallback: "browser" }, 502);
  }
}

/**
 * POST → a short-lived Cartesia access token (STT + TTS grants) and the browser-safe stream settings.
 * The API key stays on the server; the token expires in ~2 minutes and is only needed to open the sockets.
 */
export async function handleToken(_req: Request, deps: VoiceDeps & { voiceId(): string }): Promise<Response> {
  const client = deps.client();
  if (!client) return unavailable();
  let ctx: AgentContext;
  try {
    ctx = await deps.session();
  } catch (err) {
    return deps.errorResponse(err);
  }
  const rl = deps.rateLimit(ctx.actor.id, "token");
  if (!rl.allowed) return limited(rl.retryAfterSecs);
  try {
    const { token, expiresInSecs } = await client.accessToken({ stt: true, tts: true });
    deps.recordResult(true);
    deps.log("token_minted", { ttl: expiresInSecs });
    return json({ token, expiresInSecs, config: streamConfig(deps.voiceId()) });
  } catch (err) {
    if (err instanceof CartesiaError) {
      deps.recordResult(false, err);
      deps.log("token_failed", { kind: err.kind, status: err.status });
      return cartesiaFailure(err);
    }
    deps.log("token_failed", { kind: "unexpected", status: null });
    return json({ error: "Couldn't start voice streaming.", code: "CARTESIA_FAILED", fallback: "browser" }, 502);
  }
}

const STREAM_KINDS = new Set(["stt_open", "stt_transcript", "tts_audio", "stt_error", "tts_error", "auth", "network"]);

/** POST { ok, kind } from the browser after a stream works or fails. Carries no audio or text. */
export async function handleStreamHealth(req: Request, deps: VoiceDeps): Promise<Response> {
  let ctx: AgentContext;
  try {
    ctx = await deps.session();
  } catch (err) {
    return deps.errorResponse(err);
  }
  const rl = deps.rateLimit(ctx.actor.id, "health");
  if (!rl.allowed) return limited(rl.retryAfterSecs);
  const body = (await req.json().catch(() => null)) as { ok?: unknown; kind?: unknown } | null;
  if (!body || typeof body.ok !== "boolean" || typeof body.kind !== "string" || !STREAM_KINDS.has(body.kind)) {
    return json({ error: "Invalid report", code: "BAD_REQUEST" }, 400);
  }
  deps.recordStream(body.ok, body.kind);
  deps.log("stream_report", { ok: body.ok, kind: body.kind });
  return json({ ok: true });
}
