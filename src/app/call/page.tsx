"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SCAM_CALL_SCRIPT } from "@/agents/guardian/scamCallScript";
import { startCartesiaTranscriber, type CartesiaTranscriber } from "@/lib/cartesiaStt";
import {
  createCaptionRecognizer,
  fetchSpeechAudio,
  speak,
  speakWithBrowser,
  speechRecognitionSupported,
  type Recognizer,
} from "@/lib/speech";

/**
 * Protected calls: a WebRTC voice call screened live by Guardian + Claude.
 *
 * The protected person starts a call and shares the code; the caller joins.
 * With Cartesia configured, the protected person's browser transcribes the
 * caller's incoming audio itself (Cartesia ink-whisper streaming STT), so nothing
 * depends on the caller's browser. Without it, the caller's browser captions its
 * own speech and sends each phrase over the call's data channel. Either way the
 * protected side screens the rolling transcript and privately speaks a warning
 * (Cartesia voice) if the call looks like a scam.
 *
 * "Play a demo scam call" runs the whole loop on one device: a Cartesia voice
 * plays a fictional fake grandson, Cartesia STT transcribes that audio, Claude
 * and the safety rules screen it, and Guardian answers in its own voice.
 */

type Role = "protected" | "caller" | "demo";
type Phase = "idle" | "waiting" | "connecting" | "live" | "ended" | "error";
type Verdict = "scam" | "suspicious" | "safe";
type SttMode = "cartesia" | "browser" | "script";

interface Assessment {
  mode: "claude" | "rules";
  risk: "low" | "medium" | "high" | "critical";
  verdict: Verdict;
  reasons: string[];
  advice: string;
  escalated: boolean;
}

interface Line {
  id: number;
  who: "caller" | "you" | "guardian";
  text: string;
}

const VERDICT_STYLE: Record<Verdict, { bg: string; fg: string; label: string }> = {
  safe: { bg: "#e5f4f0", fg: "#0f6a63", label: "Sounds safe so far" },
  suspicious: { bg: "#fff4e0", fg: "#9a5b00", label: "Be careful" },
  scam: { bg: "#fde8e8", fg: "#b42318", label: "Likely scam" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait (bounded) for ICE gathering so the posted SDP carries all candidates. */
function waitForIce(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export default function CallPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState("");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [screening, setScreening] = useState(false);
  const [typed, setTyped] = useState("");
  const [captionsOn, setCaptionsOn] = useState(false);
  const [sttMode, setSttMode] = useState<SttMode | null>(null);
  /** Caller side: the protected person is transcribing this call with Cartesia. */
  const [remoteCartesia, setRemoteCartesia] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recRef = useRef<Recognizer | null>(null);
  const transcriberRef = useRef<CartesiaTranscriber | null>(null);
  const cartesiaActive = useRef(false);
  const demoCtxRef = useRef<AudioContext | null>(null);
  const demoAbort = useRef(false);
  const lineId = useRef(0);
  const transcriptRef = useRef<string[]>([]);
  const screenBusy = useRef(false);
  const screenPending = useRef(false);
  const spokenVerdict = useRef<Verdict>("safe");
  const speakingRef = useRef<Promise<unknown> | null>(null);
  const escalatedRef = useRef(false);
  const roomRef = useRef<string | null>(null);

  // Prefill a join code from /call?join=CODE.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("join");
    if (code) setJoinCode(code);
  }, []);

  const addLine = useCallback((who: Line["who"], text: string) => {
    setLines((prev) => [...prev, { id: ++lineId.current, who, text }].slice(-40));
  }, []);

  const teardown = useCallback(() => {
    demoAbort.current = true;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    recRef.current?.stop();
    recRef.current = null;
    transcriberRef.current?.stop();
    transcriberRef.current = null;
    cartesiaActive.current = false;
    void demoCtxRef.current?.close().catch(() => {});
    demoCtxRef.current = null;
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current = null;
    dcRef.current = null;
    streamRef.current = null;
    setCaptionsOn(false);
    setPartial("");
  }, []);

  useEffect(() => teardown, [teardown]);

  const screenNow = useCallback(async () => {
    const room = roomRef.current;
    if (!room || !transcriptRef.current.length) return;
    if (screenBusy.current) {
      screenPending.current = true;
      return;
    }
    screenBusy.current = true;
    setScreening(true);
    try {
      const result = (await postJson(`/api/voice/call/${room}/screen`, {
        transcript: transcriptRef.current.join("\n"),
      })) as Assessment;
      setAssessment(result);
      if (result.escalated) escalatedRef.current = true;
      // Speak privately (to this side only) when the verdict first gets worse.
      const rank = { safe: 0, suspicious: 1, scam: 2 };
      if (rank[result.verdict] > rank[spokenVerdict.current] && result.advice) {
        spokenVerdict.current = result.verdict;
        addLine("guardian", result.advice);
        speakingRef.current = speak(result.advice, { persona: "guardian", wait: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      screenBusy.current = false;
      setScreening(false);
      if (screenPending.current) {
        screenPending.current = false;
        void screenNow();
      }
    }
  }, [addLine]);

  /** A finalized phrase from the caller, from whichever caption source is active. */
  const handleCallerPhrase = useCallback(
    (text: string) => {
      const clean = text.trim().slice(0, 500);
      if (!clean) return;
      transcriptRef.current.push(clean);
      addLine("caller", clean);
      void screenNow();
    },
    [addLine, screenNow],
  );

  const announceCartesia = useCallback(() => {
    const dc = dcRef.current;
    if (cartesiaActive.current && dc?.readyState === "open") dc.send(JSON.stringify({ type: "stt", source: "cartesia" }));
  }, []);

  /** Protected side: transcribe the caller's incoming audio with Cartesia. */
  const transcribeRemote = useCallback(
    async (remote: MediaStream) => {
      if (transcriberRef.current) return;
      try {
        const t = await startCartesiaTranscriber({
          onPhrase: handleCallerPhrase,
          onPartial: setPartial,
          onError: (m) => setError(m),
        });
        if (!t) {
          setSttMode("browser");
          return;
        }
        transcriberRef.current = t;
        t.attachStream(remote);
        cartesiaActive.current = true;
        setSttMode("cartesia");
        announceCartesia();
      } catch (e) {
        setSttMode("browser");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [announceCartesia, handleCallerPhrase],
  );

  const preparePeer = useCallback(async (iceServers: RTCIceServer[], onRemote?: (stream: MediaStream) => void) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    streamRef.current = stream;
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => {
      // Chrome only feeds remote WebRTC audio into Web Audio while a media element plays it.
      if (audioRef.current) {
        audioRef.current.srcObject = e.streams[0];
        void audioRef.current.play().catch(() => {});
      }
      onRemote?.(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setPhase("live");
      if (pc.connectionState === "failed") {
        setError("Couldn't connect the call (network blocked peer-to-peer audio).");
        setPhase("error");
      }
      if (pc.connectionState === "disconnected" || pc.connectionState === "closed") setPhase("ended");
    };
    return pc;
  }, []);

  /** Protected person: create the room, make the offer, screen what the caller says. */
  const startProtected = useCallback(async () => {
    setRole("protected");
    setError(null);
    setPhase("waiting");
    try {
      const { roomId: id, iceServers } = await postJson("/api/voice/call", {});
      roomRef.current = id;
      setRoomId(id);
      const pc = await preparePeer(iceServers, (remote) => void transcribeRemote(remote));
      const dc = pc.createDataChannel("captions");
      dcRef.current = dc;
      dc.onopen = announceCartesia;
      dc.onmessage = (e) => {
        let msg: { type?: string; text?: string };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (typeof msg.text !== "string") return;
        // Typed lines always count; spoken captions only while Cartesia isn't hearing the audio itself.
        if (msg.type === "typed" || (msg.type === "caption" && !cartesiaActive.current)) handleCallerPhrase(msg.text);
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      await postJson(`/api/voice/call/${id}`, { description: pc.localDescription });

      pollRef.current = setInterval(async () => {
        const res = await fetch(`/api/voice/call/${id}`);
        if (!res.ok) return;
        const room = await res.json();
        if (room.hungUp) {
          teardown();
          setPhase("ended");
        } else if (room.answer && !pc.remoteDescription) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("connecting");
          await pc.setRemoteDescription(room.answer);
        }
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      teardown();
    }
  }, [announceCartesia, handleCallerPhrase, preparePeer, teardown, transcribeRemote]);

  /** Caller: join by code and answer. Captions their own speech until told Cartesia is listening. */
  const joinAsCaller = useCallback(async () => {
    const code = joinCode.trim().toLowerCase();
    if (!code) return;
    setRole("caller");
    setError(null);
    setPhase("connecting");
    try {
      const res = await fetch(`/api/voice/call/${encodeURIComponent(code)}`);
      const room = await res.json();
      if (!res.ok) throw new Error(room.error === "room_not_found" ? "No call with that code." : room.error);
      if (!room.offer) throw new Error("That call isn't ready yet. Try again in a moment.");
      if (room.answer) throw new Error("Someone already joined that call.");
      roomRef.current = code;
      setRoomId(code);
      const pc = await preparePeer(room.iceServers);
      pc.ondatachannel = (e) => {
        dcRef.current = e.channel;
        e.channel.onmessage = (m) => {
          let msg: { type?: string; source?: string };
          try {
            msg = JSON.parse(m.data);
          } catch {
            return;
          }
          if (msg.type === "stt" && msg.source === "cartesia") {
            recRef.current?.stop();
            recRef.current = null;
            setCaptionsOn(false);
            setRemoteCartesia(true);
          }
        };
      };
      await pc.setRemoteDescription(room.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIce(pc);
      await postJson(`/api/voice/call/${code}`, { description: pc.localDescription });

      const rec = createCaptionRecognizer({
        onPhrase: (text) => sendCaption(text, "caption"),
        onError: (err) => {
          if (err === "not-allowed") setError("Captions need microphone permission.");
        },
      });
      if (rec) {
        recRef.current = rec;
        rec.start();
        setCaptionsOn(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      teardown();
    }
  }, [joinCode, preparePeer, teardown]);

  function sendCaption(text: string, type: "caption" | "typed") {
    const dc = dcRef.current;
    if (dc?.readyState === "open") dc.send(JSON.stringify({ type, text }));
    addLine("you", text);
  }

  /** Wait (bounded) until screening has caught up with the transcript. */
  async function waitForScreening(timeoutMs = 20000) {
    const start = Date.now();
    while ((screenBusy.current || screenPending.current) && Date.now() - start < timeoutMs) await sleep(100);
  }

  /** One-device demo: a Cartesia voice plays the scammer; Cartesia STT hears it; Guardian screens. */
  const runDemoCall = useCallback(async () => {
    setRole("demo");
    setError(null);
    setPhase("connecting");
    demoAbort.current = false;
    escalatedRef.current = false;
    const ctx = new AudioContext();
    demoCtxRef.current = ctx;
    try {
      const { roomId: id } = await postJson("/api/voice/call", {});
      roomRef.current = id;
      setRoomId(id);
      const t = await startCartesiaTranscriber({
        ctx,
        onPhrase: handleCallerPhrase,
        onPartial: setPartial,
        onError: (m) => setError(m),
      });
      transcriberRef.current = t;
      setSttMode(t ? "cartesia" : "script");
      setPhase("live");

      for (const text of SCAM_CALL_SCRIPT) {
        if (demoAbort.current) break;
        const audio = t ? await fetchSpeechAudio(text, "scam-caller") : null;
        if (demoAbort.current) break;
        if (t && audio) {
          // The transcript comes from Cartesia STT hearing this audio, not from the script.
          const buffer = await ctx.decodeAudioData(audio);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          src.connect(t.input);
          await new Promise<void>((resolve) => {
            src.onended = () => resolve();
            src.start();
          });
          await sleep(400);
          await t.flush();
        } else {
          // No Cartesia: browser voice, and the script text stands in for STT (labelled in the UI).
          await speakWithBrowser(text, { rate: 1.05, pitch: 1.2 });
          handleCallerPhrase(text);
        }
        await waitForScreening();
        if (speakingRef.current) await speakingRef.current;
        speakingRef.current = null;
        if (escalatedRef.current) break;
        await sleep(500);
      }
      if (!demoAbort.current) {
        transcriberRef.current?.stop();
        transcriberRef.current = null;
        setPhase("ended");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      teardown();
    }
  }, [handleCallerPhrase, teardown]);

  const hangUpCall = useCallback(async () => {
    const room = roomRef.current;
    const wasDemo = role === "demo";
    teardown();
    setPhase("ended");
    if (room && !wasDemo) await postJson(`/api/voice/call/${room}`, { hangup: true }).catch(() => {});
  }, [role, teardown]);

  const joinLink =
    roomId && typeof window !== "undefined" ? `${window.location.origin}/call?join=${roomId}` : null;
  const inCall = phase === "waiting" || phase === "connecting" || phase === "live";
  const style = assessment ? VERDICT_STYLE[assessment.verdict] : null;
  const listening = role === "protected" || role === "demo";
  const sttLabel =
    sttMode === "cartesia"
      ? "Heard by Cartesia speech-to-text"
      : sttMode === "script"
        ? "Script text (no Cartesia key)"
        : sttMode === "browser"
          ? "Caller's browser captions"
          : null;

  return (
    <main className="px-5 pt-8 pb-32">
      <audio ref={audioRef} autoPlay playsInline />
      <h1 className="text-[28px] font-extrabold tracking-tight">Protected calls</h1>
      <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--muted)]">
        Talk over a private in-app call while Guardian listens for scam tactics and warns only you.
      </p>

      {!role && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="card p-4">
            <h2 className="text-[17px] font-bold">Start a protected call</h2>
            <p className="mt-1 text-[14px] text-[var(--muted)]">
              You'll get a code to share with the person who wants to talk to you.
            </p>
            <button
              onClick={startProtected}
              className="btn mt-3 w-full py-3 text-[15px] text-white"
              style={{ background: "var(--brand-grad)" }}
            >
              Start call
            </button>
          </div>
          <div className="card p-4">
            <h2 className="text-[17px] font-bold">Join as the caller</h2>
            <p className="mt-1 text-[14px] text-[var(--muted)]">
              What you say is transcribed and screened by the person you're calling.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="Call code"
                className="min-w-0 flex-1 rounded-[14px] border border-[var(--line)] px-3 py-2.5 text-[15px]"
              />
              <button
                onClick={joinAsCaller}
                className="btn px-4 py-2.5 text-[15px]"
                style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
              >
                Join
              </button>
            </div>
          </div>
          <div className="card p-4">
            <h2 className="text-[17px] font-bold">Hear a demo scam call</h2>
            <p className="mt-1 text-[14px] text-[var(--muted)]">
              A voice plays a fictional "grandson" asking for gift cards. Guardian listens, screens and warns you, all on
              this device. Turn your sound on.
            </p>
            <button
              onClick={runDemoCall}
              className="btn mt-3 w-full py-3 text-[15px]"
              style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
            >
              Play demo scam call
            </button>
          </div>
        </section>
      )}

      {role && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="eyebrow">
                  {role === "protected" ? "You are protected" : role === "demo" ? "Demo call (fictional)" : "You are the caller"}
                </div>
                <div className="mt-1 text-[17px] font-bold">
                  {phase === "waiting" && "Waiting for the caller…"}
                  {phase === "connecting" && "Connecting…"}
                  {phase === "live" && (role === "demo" ? "\"Jake\" is calling…" : "On the call")}
                  {phase === "ended" && "Call ended"}
                  {phase === "error" && "Call problem"}
                </div>
              </div>
              {inCall && (
                <button
                  onClick={hangUpCall}
                  className="btn pill shrink-0 px-4 py-2 text-[14px] text-white"
                  style={{ background: "#d92d20" }}
                >
                  Hang up
                </button>
              )}
            </div>
            {role === "protected" && phase === "waiting" && roomId && (
              <div className="mt-3 rounded-[14px] p-3" style={{ background: "var(--brand-soft)" }}>
                <div className="text-[13px] text-[var(--muted)]">Share this code</div>
                <div className="text-[26px] font-extrabold tracking-[0.15em]" style={{ color: "var(--brand-ink)" }}>
                  {roomId}
                </div>
                {joinLink && <div className="mt-1 break-all text-[12px] text-[var(--muted)]">{joinLink}</div>}
              </div>
            )}
            {role === "caller" && inCall && (
              <div className="mt-2 text-[13px] text-[var(--muted)]">
                {remoteCartesia
                  ? "The person you called is screening this call with live speech-to-text."
                  : captionsOn
                    ? "Live captions on: what you say is shared with the person you called."
                    : speechRecognitionSupported()
                      ? "Starting captions…"
                      : "This browser can't caption speech. Type what you say below."}
              </div>
            )}
          </div>

          {listening && (
            <div className="card p-4" style={style ? { background: style.bg, borderColor: "transparent" } : undefined}>
              <div className="flex items-center justify-between">
                <div className="eyebrow">Guardian</div>
                {assessment && (
                  <span className="text-[12px] text-[var(--muted)]">
                    {assessment.mode === "claude" ? "Checked by Claude" : "Checked by safety rules"}
                    {screening ? " · updating" : ""}
                  </span>
                )}
              </div>
              {!assessment ? (
                <p className="mt-1 text-[15px] text-[var(--muted)]">
                  {screening ? "Listening…" : "I'll check what the caller says as they talk."}
                </p>
              ) : (
                <>
                  <div className="mt-1 text-[20px] font-extrabold" style={{ color: style!.fg }}>
                    {style!.label}
                  </div>
                  {assessment.advice && <p className="mt-1.5 text-[15px] leading-relaxed">{assessment.advice}</p>}
                  {assessment.reasons.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-[14px] text-[var(--muted)]">
                      {assessment.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {assessment.escalated && (
                    <p className="mt-2 text-[13px] font-semibold" style={{ color: style!.fg }}>
                      Logged as an incident and shared with your trusted contacts.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {role === "caller" && inCall && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const t = typed.trim();
                if (t) sendCaption(t, "typed");
                setTyped("");
              }}
            >
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Or type what you say"
                className="min-w-0 flex-1 rounded-[14px] border border-[var(--line)] px-3 py-2.5 text-[15px]"
              />
              <button
                type="submit"
                className="btn px-4 py-2.5 text-[15px]"
                style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
              >
                Send
              </button>
            </form>
          )}

          {(lines.length > 0 || partial) && (
            <div className="card p-4">
              <div className="flex items-center justify-between">
                <div className="eyebrow">Live transcript</div>
                {listening && sttLabel && <span className="text-[12px] text-[var(--muted)]">{sttLabel}</span>}
              </div>
              <ul className="mt-2 flex flex-col gap-1.5">
                {lines.map((l) => (
                  <li key={l.id} className="text-[14px] leading-relaxed">
                    <span className="font-semibold">
                      {l.who === "caller" ? "Caller: " : l.who === "guardian" ? "Guardian (only you hear this): " : "You: "}
                    </span>
                    {l.text}
                  </li>
                ))}
                {partial && (
                  <li className="text-[14px] italic leading-relaxed text-[var(--muted)]">
                    <span className="font-semibold">Caller: </span>
                    {partial}…
                  </li>
                )}
              </ul>
            </div>
          )}

          {error && (
            <div className="card p-3 text-[14px]" style={{ color: "#b42318" }}>
              {error}
            </div>
          )}

          {(phase === "ended" || phase === "error") && (
            <button
              onClick={() => {
                teardown();
                setRole(null);
                setPhase("idle");
                setRoomId(null);
                roomRef.current = null;
                setLines([]);
                setAssessment(null);
                setError(null);
                setSttMode(null);
                setRemoteCartesia(false);
                transcriptRef.current = [];
                spokenVerdict.current = "safe";
                escalatedRef.current = false;
              }}
              className="btn py-3 text-[15px]"
              style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}
            >
              New call
            </button>
          )}
        </section>
      )}
    </main>
  );
}
