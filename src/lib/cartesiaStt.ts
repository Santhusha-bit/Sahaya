"use client";

/**
 * Browser live captions with Cartesia streaming STT (ink-whisper).
 *
 * Unlike the Web Speech API, this can transcribe ANY audio, including the remote
 * side of a WebRTC call, so the protected person's browser hears the caller
 * directly. Audio is tapped with an AudioWorklet, resampled to 16 kHz s16le and
 * streamed in ~100 ms chunks. The browser only holds a short-lived, STT-only
 * token from /api/voice/stt-token; the API key never leaves the server.
 */

export interface CartesiaTranscriber {
  ctx: AudioContext;
  /** Connect any audio node here to have it transcribed. */
  input: AudioNode;
  /** Transcribe a MediaStream (e.g. the caller's remote WebRTC audio). */
  attachStream: (stream: MediaStream) => void;
  /** Ask Cartesia to finalize buffered audio now; resolves on flush_done (bounded). */
  flush: () => Promise<void>;
  stop: () => void;
}

interface SttSession {
  url: string;
  sampleRate: number;
}

const TAP_WORKLET = `
class SahayaSttTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // Post silence when nothing is connected so Cartesia can finalize on pauses.
    this.port.postMessage(ch ? ch.slice(0) : new Float32Array(128));
    return true;
  }
}
registerProcessor("sahaya-stt-tap", SahayaSttTap);
`;

/** Box-filter downsampler + float -> s16le, emitting fixed-size chunks. */
function createEncoder(fromRate: number, toRate: number, chunkSamples: number, emit: (chunk: ArrayBuffer) => void) {
  const ratio = fromRate / toRate;
  let acc = 0;
  let n = 0;
  let need = ratio;
  let buf = new Int16Array(chunkSamples);
  let filled = 0;
  const out = (v: number) => {
    const s = Math.max(-1, Math.min(1, v));
    buf[filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (filled === chunkSamples) {
      emit(buf.buffer);
      buf = new Int16Array(chunkSamples);
      filled = 0;
    }
  };
  return (frame: Float32Array) => {
    for (let i = 0; i < frame.length; i++) {
      acc += frame[i];
      n++;
      need -= 1;
      while (need <= 0) {
        out(acc / n);
        acc = 0;
        n = 0;
        need += ratio;
      }
    }
  };
}

/**
 * Start a Cartesia transcriber. Resolves null when Cartesia isn't configured on the
 * server (the caller then falls back to browser captions).
 */
export async function startCartesiaTranscriber(opts: {
  onPhrase: (text: string) => void;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  /** Reuse an existing AudioContext (it is not closed on stop). */
  ctx?: AudioContext;
}): Promise<CartesiaTranscriber | null> {
  const res = await fetch("/api/voice/stt-token", { method: "POST" }).catch(() => null);
  if (!res || res.status !== 200) return null;
  const session = (await res.json()) as SttSession;

  const ownsCtx = !opts.ctx;
  const ctx = opts.ctx ?? new AudioContext();
  await ctx.resume().catch(() => {});
  const moduleUrl = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }

  const ws = new WebSocket(session.url);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Couldn't connect to Cartesia speech-to-text."));
  });

  const input = ctx.createGain();
  const tap = new AudioWorkletNode(ctx, "sahaya-stt-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  input.connect(tap);
  tap.connect(mute);
  mute.connect(ctx.destination);

  const encode = createEncoder(ctx.sampleRate, session.sampleRate, session.sampleRate / 10, (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });
  tap.port.onmessage = (e) => encode(e.data as Float32Array);

  let flushWaiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    let msg: { type?: string; is_final?: boolean; text?: string; message?: string };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === "transcript") {
      const text = (msg.text ?? "").trim();
      if (msg.is_final) {
        opts.onPartial?.("");
        if (text) opts.onPhrase(text);
      } else {
        opts.onPartial?.(text);
      }
    } else if (msg.type === "flush_done") {
      flushWaiters.forEach((w) => w());
      flushWaiters = [];
    } else if (msg.type === "error") {
      opts.onError?.(msg.message ?? "Cartesia speech-to-text error");
    }
  };
  ws.onerror = () => opts.onError?.("Cartesia speech-to-text connection dropped.");

  const sources: MediaStreamAudioSourceNode[] = [];
  let stopped = false;

  return {
    ctx,
    input,
    attachStream(stream) {
      const src = ctx.createMediaStreamSource(stream);
      src.connect(input);
      sources.push(src);
    },
    flush() {
      if (ws.readyState !== WebSocket.OPEN) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        flushWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        ws.send("finalize");
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      tap.port.onmessage = null;
      sources.forEach((s) => s.disconnect());
      input.disconnect();
      tap.disconnect();
      mute.disconnect();
      if (ws.readyState === WebSocket.OPEN) ws.send("close");
      setTimeout(() => ws.close(), 1500);
      if (ownsCtx) void ctx.close().catch(() => {});
    },
  };
}
