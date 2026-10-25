/**
 * WebRTC call signaling (scam-call demo).
 *
 * Two browsers join a room: the protected person creates it (and makes the
 * offer), the caller joins by code (and answers). Audio flows
 * peer-to-peer; this module only relays the SDP offer/answer. Each side waits for
 * ICE gathering to complete before posting its description, so no trickle ICE
 * (and no WebSocket) is needed: just two POSTs and a short poll.
 *
 * Rooms live in process memory with a TTL. That is fine for `next dev` / a single
 * Node server; on multi-instance serverless hosts both peers must hit the same
 * instance, so run the demo on one server.
 */

import { randomBytes } from "node:crypto";

export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface CallRoom {
  id: string;
  createdAt: number;
  offer: SessionDescription | null;
  answer: SessionDescription | null;
  hungUp: boolean;
}

const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_SDP_BYTES = 64 * 1024;
const rooms = new Map<string, CallRoom>();

function sweep(now = Date.now()): void {
  for (const [key, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(key);
}

/** Short, unguessable, human-typeable room code. */
function roomCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function createRoom(): CallRoom {
  sweep();
  const room: CallRoom = { id: roomCode(), createdAt: Date.now(), offer: null, answer: null, hungUp: false };
  rooms.set(room.id, room);
  return room;
}

export function getRoom(roomId: string): CallRoom | null {
  sweep();
  return rooms.get(roomId) ?? null;
}

export function isSessionDescription(v: unknown): v is SessionDescription {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (
    (d.type === "offer" || d.type === "answer") &&
    typeof d.sdp === "string" &&
    d.sdp.length > 0 &&
    d.sdp.length <= MAX_SDP_BYTES
  );
}

/**
 * Store a peer's description. The room creator posts the offer, the joiner posts
 * the answer; each slot is write-once so a third party cannot hijack a live call.
 */
export function postDescription(
  roomId: string,
  desc: SessionDescription,
): { ok: true; room: CallRoom } | { ok: false; error: string } {
  const room = getRoom(roomId);
  if (!room) return { ok: false, error: "room_not_found" };
  if (room.hungUp) return { ok: false, error: "call_ended" };
  if (desc.type === "offer") {
    if (room.offer) return { ok: false, error: "offer_already_set" };
    room.offer = desc;
  } else {
    if (!room.offer) return { ok: false, error: "no_offer_yet" };
    if (room.answer) return { ok: false, error: "answer_already_set" };
    room.answer = desc;
  }
  return { ok: true, room };
}

export function hangUp(roomId: string): boolean {
  const room = getRoom(roomId);
  if (!room) return false;
  room.hungUp = true;
  return true;
}

/**
 * ICE servers handed to browsers. Public STUN by default; set WEBRTC_ICE_SERVERS
 * to a JSON RTCIceServer[] (e.g. with a TURN relay) for restrictive networks.
 */
export function iceServers(): { urls: string | string[]; username?: string; credential?: string }[] {
  const raw = process.env.WEBRTC_ICE_SERVERS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* fall back to public STUN */
    }
  }
  return [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
}

/** Test hook. */
export function _resetRooms(): void {
  rooms.clear();
}
