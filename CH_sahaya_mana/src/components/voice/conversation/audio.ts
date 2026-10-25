"use client";

/**
 * Microphone capture → 16 kHz mono PCM16 chunks (~100 ms) via an AudioWorklet, plus a gapless PCM16 player.
 * Capture downsamples from the device rate inside the worklet, so it works in Chrome, Safari and Firefox.
 */

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions.targetRate;
    this.ratio = sampleRate / this.target;
    this.chunk = Math.round(this.target / 10); // 100 ms
    this.out = new Int16Array(this.chunk);
    this.n = 0;
    this.pos = 0;
    this.sumSq = 0;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { this.sumSq += ch[i] * ch[i]; this.count++; }
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.chunk) {
        const rms = Math.sqrt(this.sumSq / Math.max(1, this.count));
        this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
        this.out = new Int16Array(this.chunk);
        this.n = 0; this.sumSq = 0; this.count = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("sahaya-pcm-capture", PcmCapture);
`;

export interface MicCapture {
  stop(): void;
  setMuted(muted: boolean): void;
}

export class MicPermissionError extends Error {}

export async function startMicCapture(
  ctx: AudioContext,
  targetRate: number,
  onChunk: (pcm: ArrayBuffer, rms: number) => void,
): Promise<MicCapture> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    throw new MicPermissionError(
      name === "NotAllowedError" || name === "SecurityError"
        ? "Microphone permission was denied. Allow the microphone in your browser settings, then try again."
        : name === "NotFoundError"
          ? "No microphone was found."
          : "Couldn't start the microphone.",
    );
  }
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "sahaya-pcm-capture", { processorOptions: { targetRate } });
  let muted = false;
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
    if (!muted) onChunk(e.data.pcm, e.data.rms);
  };
  source.connect(node);
  // Keep the graph pulling audio without playing the mic back to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  return {
    setMuted(m) {
      muted = m;
      stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    },
    stop() {
      node.port.onmessage = null;
      try {
        source.disconnect();
        node.disconnect();
        sink.disconnect();
      } catch {
        /* already disconnected */
      }
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** Gapless playback of raw PCM16 chunks; stop() silences immediately (barge-in). */
export class PcmPlayer {
  private nextAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private onIdle: (() => void) | null = null;
  private finished = false;

  constructor(private readonly ctx: AudioContext, private readonly sampleRate: number) {}

  get playing() {
    return this.sources.size > 0;
  }

  /** Call when the stream says the generation is complete; onIdle fires after the last chunk plays. */
  markFinished(onIdle: () => void) {
    this.finished = true;
    this.onIdle = onIdle;
    if (this.sources.size === 0) this.fireIdle();
  }

  begin() {
    this.finished = false;
    this.onIdle = null;
  }

  push(base64: string) {
    const bin = atob(base64);
    const n = Math.floor(bin.length / 2);
    if (!n) return;
    const buf = this.ctx.createBuffer(1, n, this.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      data[i] = v / 0x8000;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.03, this.nextAt);
    src.start(startAt);
    this.nextAt = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.finished && this.sources.size === 0) this.fireIdle();
    };
  }

  stop() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources.clear();
    this.nextAt = 0;
    this.finished = false;
    this.onIdle = null;
  }

  private fireIdle() {
    const cb = this.onIdle;
    this.onIdle = null;
    this.finished = false;
    cb?.();
  }
}
