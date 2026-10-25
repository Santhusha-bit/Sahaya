import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEscalations,
  maxRisk,
  parseAssessment,
  screenCallTranscript,
  type ClaudeCallAssessment,
} from "@/integrations/callScreening";
import {
  _resetRooms,
  createRoom,
  getRoom,
  hangUp,
  iceServers,
  isSessionDescription,
  postDescription,
} from "@/integrations/webrtc";

const SCAM = "Grandma it's Jake, I'm in jail and need $2000 in gift cards for bail today. Don't tell mom.";
const FRIENDLY = "Hi Mom, just calling to say I'll be over for dinner on Sunday. Love you.";

describe("WebRTC signaling", () => {
  beforeEach(() => _resetRooms());

  it("relays a write-once offer then answer", () => {
    const room = createRoom();
    expect(room.id).toMatch(/^[a-z2-9]{8}$/);
    expect(postDescription(room.id, { type: "answer", sdp: "v=0" })).toEqual({ ok: false, error: "no_offer_yet" });
    expect(postDescription(room.id, { type: "offer", sdp: "v=0 offer" }).ok).toBe(true);
    expect(postDescription(room.id, { type: "offer", sdp: "v=0 hijack" })).toEqual({ ok: false, error: "offer_already_set" });
    expect(postDescription(room.id, { type: "answer", sdp: "v=0 answer" }).ok).toBe(true);
    expect(postDescription(room.id, { type: "answer", sdp: "v=0 hijack" })).toEqual({ ok: false, error: "answer_already_set" });
    expect(getRoom(room.id)?.answer?.sdp).toBe("v=0 answer");
  });

  it("rejects descriptions after hang up and for unknown rooms", () => {
    const room = createRoom();
    expect(hangUp(room.id)).toBe(true);
    expect(postDescription(room.id, { type: "offer", sdp: "v=0" })).toEqual({ ok: false, error: "call_ended" });
    expect(postDescription("nope", { type: "offer", sdp: "v=0" })).toEqual({ ok: false, error: "room_not_found" });
  });

  it("validates SDP payloads", () => {
    expect(isSessionDescription({ type: "offer", sdp: "v=0" })).toBe(true);
    expect(isSessionDescription({ type: "pranswer", sdp: "v=0" })).toBe(false);
    expect(isSessionDescription({ type: "offer", sdp: "" })).toBe(false);
    expect(isSessionDescription({ type: "offer", sdp: "x".repeat(70_000) })).toBe(false);
  });

  it("defaults to public STUN and honors WEBRTC_ICE_SERVERS", () => {
    expect(JSON.stringify(iceServers())).toContain("stun:");
    vi.stubEnv("WEBRTC_ICE_SERVERS", JSON.stringify([{ urls: "turn:t.example:3478", username: "u", credential: "p" }]));
    expect(iceServers()[0].urls).toBe("turn:t.example:3478");
    vi.unstubAllEnvs();
  });
});

describe("WebRTC + Claude call screening", () => {
  beforeEach(() => _resetEscalations());

  it("parses Claude's assessment and drops malformed output", () => {
    expect(parseAssessment({ verdict: "scam", risk: "high", reasons: ["gift cards", 3], advice: "Hang up." })).toEqual({
      verdict: "scam",
      risk: "high",
      reasons: ["gift cards"],
      advice: "Hang up.",
    });
    expect(parseAssessment({ verdict: "maybe", risk: "high", reasons: [], advice: "" })).toBeNull();
    expect(parseAssessment(null)).toBeNull();
    expect(maxRisk("low", "high")).toBe("high");
  });

  it("uses Claude's assessment and escalates to Guardian once per call", async () => {
    const assess = vi.fn(
      async (): Promise<ClaudeCallAssessment> => ({
        verdict: "scam",
        risk: "critical",
        reasons: ["Asks for gift cards", "Demands secrecy"],
        advice: "This is likely a scam. Hang up.",
      }),
    );
    const first = await screenCallTranscript({ callId: "call-a", userId: "call-test-user", transcript: SCAM, assess });
    expect(first.mode).toBe("claude");
    expect(first.verdict).toBe("scam");
    expect(first.reasons).toContain("Asks for gift cards");
    expect(first.escalated).toBe(true);
    expect(first.warning?.length).toBeGreaterThan(0);
    expect(assess).toHaveBeenCalledWith(SCAM);

    const second = await screenCallTranscript({ callId: "call-a", userId: "call-test-user", transcript: SCAM, assess });
    expect(second.escalated).toBe(false);
  });

  it("never lets a model 'safe' verdict lower deterministic risk", async () => {
    const r = await screenCallTranscript({
      callId: "call-b",
      userId: "call-test-user",
      transcript: SCAM,
      assess: async () => ({ verdict: "safe", risk: "low", reasons: [], advice: "All good." }),
    });
    expect(r.verdict).toBe("scam");
    expect(["high", "critical"]).toContain(r.risk);
    expect(r.escalated).toBe(true);
  });

  it("falls back to deterministic rules when Claude is unavailable or errors", async () => {
    const r = await screenCallTranscript({
      callId: "call-c",
      userId: "call-test-user",
      transcript: SCAM,
      assess: async () => {
        throw new Error("network down");
      },
    });
    expect(r.mode).toBe("rules");
    expect(r.claudeError).toBe("network down");
    expect(r.verdict).toBe("scam");
  });

  it("leaves a friendly call alone", async () => {
    const r = await screenCallTranscript({
      callId: "call-d",
      userId: "call-test-user",
      transcript: FRIENDLY,
      assess: async () => ({ verdict: "safe", risk: "low", reasons: [], advice: "" }),
    });
    expect(r.verdict).toBe("safe");
    expect(r.escalated).toBe(false);
  });
});
